import readline from 'readline';

import async from 'async';
import chalk from 'chalk';
import invariant from 'tiny-invariant';

import logger from './logger';
import telemetry from './telemetry';
import { runAssertions } from './assertions';
import { generatePrompts } from './suggestions';
import { getNunjucksEngine, sha256 } from './util';
import { maybeEmitAzureOpenAiWarning } from './providers/azureopenaiUtil';

import type { SingleBar } from 'cli-progress';
import type {
  ApiProvider,
  AtomicTestCase,
  EvaluateOptions,
  EvaluateResult,
  EvaluateStats,
  EvaluateSummary,
  EvaluateTable,
  NunjucksFilterMap,
  Prompt,
  TestCase,
  TestSuite,
} from './types';

interface RunEvalOptions {
  provider: ApiProvider;
  prompt: Prompt;
  delay: number;

  test: AtomicTestCase;
  nunjucksFilters?: NunjucksFilterMap;

  includeProviderId?: boolean;

  rowIndex: number;
  colIndex: number;
  repeatIndex: number;
}

export const DEFAULT_MAX_CONCURRENCY = 4;

function generateVarCombinations(
  vars: Record<string, string | string[] | any>,
): Record<string, string | any[]>[] {
  const keys = Object.keys(vars);
  const combinations: Record<string, string | any[]>[] = [{}];

  for (const key of keys) {
    let values: any[] = Array.isArray(vars[key]) ? vars[key] : [vars[key]];

    // Check if it's an array but not a string array
    if (Array.isArray(vars[key]) && typeof vars[key][0] !== 'string') {
      values = [vars[key]];
    }

    const newCombinations: Record<string, any>[] = [];

    for (const combination of combinations) {
      for (const value of values) {
        newCombinations.push({ ...combination, [key]: value });
      }
    }

    combinations.length = 0;
    combinations.push(...newCombinations);
  }

  return combinations;
}

export async function renderPrompt(
  prompt: Prompt,
  vars: Record<string, string | object>,
  nunjucksFilters?: NunjucksFilterMap,
): Promise<string> {
  const nunjucks = getNunjucksEngine(nunjucksFilters);
  let basePrompt = prompt.raw;
  if (prompt.function) {
    const result = await prompt.function({ vars });
    if (typeof result === 'string') {
      basePrompt = result;
    } else if (typeof result === 'object') {
      basePrompt = JSON.stringify(result);
    } else {
      throw new Error(`Prompt function must return a string or object, got ${typeof result}`);
    }
    // TODO(ian): Handle promise
  }

  try {
    if (process.env.PROMPTFOO_DISABLE_JSON_AUTOESCAPE) {
      return nunjucks.renderString(basePrompt, vars);
    }

    const parsed = JSON.parse(basePrompt);

    // Remove any trailing newlines from vars
    for (const key of Object.keys(vars)) {
      if (typeof vars[key] === 'string') {
        vars[key] = (vars[key] as string).replace(/\n$/, '');
      }
    }

    // The _raw_ prompt is valid JSON. That means that the user likely wants to substitute vars _within_ the JSON itself.
    // Recursively walk the JSON structure. If we find a string, render it with nunjucks.
    const walk = (obj: any) => {
      if (typeof obj === 'string') {
        return nunjucks.renderString(obj, vars);
      } else if (typeof obj === 'object') {
        for (const key of Object.keys(obj)) {
          obj[key] = walk(obj[key]);
        }
      }
      return obj;
    };
    return JSON.stringify(walk(parsed));
  } catch (err) {
    return nunjucks.renderString(basePrompt, vars);
  }
}

class Evaluator {
  testSuite: TestSuite;
  options: EvaluateOptions;
  stats: EvaluateStats;
  conversations: Record<
    string,
    { prompt: string | object; input: string; output: string | object }[]
  >;

  constructor(testSuite: TestSuite, options: EvaluateOptions) {
    this.testSuite = testSuite;
    this.options = options;
    this.stats = {
      successes: 0,
      failures: 0,
      tokenUsage: {
        total: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
      },
    };
    this.conversations = {};
  }

  async runEval({
    provider,
    prompt,
    test,
    includeProviderId,
    delay,
    nunjucksFilters: filters,
  }: RunEvalOptions): Promise<EvaluateResult> {
    // Use the original prompt to set the display, not renderedPrompt
    let promptDisplay = prompt.display;
    if (includeProviderId) {
      promptDisplay = `[${provider.id()}] ${promptDisplay}`;
    }

    // Set up the special _conversation variable
    const vars = test.vars || {};
    const conversationKey = `${provider.id()}:${prompt.id}`;
    const usesConversation = prompt.raw.includes('_conversation');
    if (!process.env.PROMPTFOO_DISABLE_CONVERSATION_VAR && usesConversation) {
      vars._conversation = this.conversations[conversationKey] || [];
    }

    // Render the prompt
    const renderedPrompt = await renderPrompt(prompt, vars, filters);

    let renderedJson = undefined;
    try {
      renderedJson = JSON.parse(renderedPrompt);
    } catch {}

    const setup = {
      provider: {
        id: provider.id(),
      },
      prompt: {
        raw: renderedPrompt,
        display: promptDisplay,
      },
      vars,
    };

    // Call the API
    let latencyMs = 0;
    try {
      const startTime = Date.now();
      const response = await provider.callApi(renderedPrompt, {
        vars,
      });
      const endTime = Date.now();
      latencyMs = endTime - startTime;

      let conversationLastInput = undefined;
      if (renderedJson && Array.isArray(renderedJson)) {
        const lastElt = renderedJson[renderedJson.length - 1];
        // Use the `content` field if present (OpenAI chat format)
        conversationLastInput = lastElt?.content || lastElt;
      }
      this.conversations[conversationKey] = this.conversations[conversationKey] || [];
      this.conversations[conversationKey].push({
        prompt: renderedJson || renderedPrompt,
        input: conversationLastInput || renderedJson || renderedPrompt,
        output: response.output || '',
      });

      if (!response.cached) {
        let sleep = delay;
        if (!delay && process.env.PROMPTFOO_DELAY_MS) {
          sleep = parseInt(process.env.PROMPTFOO_DELAY_MS, 10) || 0;
        }
        if (sleep) {
          logger.debug(`Sleeping for ${sleep}ms`);
          await new Promise((resolve) => setTimeout(resolve, sleep));
        }
      }

      const ret: EvaluateResult = {
        ...setup,
        response,
        success: false,
        score: 0,
        namedScores: {},
        latencyMs,
      };
      if (response.error) {
        ret.error = response.error;
      } else if (response.output) {
        // Create a copy of response so we can potentially mutate it.
        let processedResponse = { ...response };
        if (test.options?.postprocess) {
          const { postprocess } = test.options;
          const postprocessFn = new Function(
            'output',
            'context',
            postprocess.includes('\n') ? postprocess : `return ${postprocess}`,
          );
          processedResponse.output = postprocessFn(processedResponse.output, {
            vars,
          });
          if (processedResponse.output == null) {
            throw new Error('Postprocess function did not return a value');
          }
        }

        invariant(processedResponse.output != null, 'Response output should not be null');
        const checkResult = await runAssertions({
          prompt: renderedPrompt,
          provider,
          test,
          output: processedResponse.output,
        });
        if (!checkResult.pass) {
          ret.error = checkResult.reason;
        }
        ret.success = checkResult.pass;
        ret.score = checkResult.score;
        ret.namedScores = checkResult.namedScores || {};
        if (checkResult.tokensUsed) {
          this.stats.tokenUsage.total += checkResult.tokensUsed.total;
          this.stats.tokenUsage.prompt += checkResult.tokensUsed.prompt;
          this.stats.tokenUsage.completion += checkResult.tokensUsed.completion;
        }
        ret.response = processedResponse;
        ret.gradingResult = checkResult;
      } else {
        ret.success = false;
        ret.score = 0;
        ret.error = 'No output';
      }

      // Update token usage stats
      if (response.tokenUsage) {
        this.stats.tokenUsage.total += response.tokenUsage.total || 0;
        this.stats.tokenUsage.prompt += response.tokenUsage.prompt || 0;
        this.stats.tokenUsage.completion += response.tokenUsage.completion || 0;
        this.stats.tokenUsage.cached += response.tokenUsage.cached || 0;
      }

      if (ret.success) {
        this.stats.successes++;
      } else {
        this.stats.failures++;
      }

      return ret;
    } catch (err) {
      return {
        ...setup,
        error: String(err) + '\n\n' + (err as Error).stack,
        success: false,
        score: 0,
        namedScores: {},
        latencyMs,
      };
    }
  }

  async evaluate(): Promise<EvaluateSummary> {
    const { testSuite, options } = this;
    const prompts: Prompt[] = [];

    if (options.generateSuggestions) {
      // TODO(ian): Move this into its own command/file
      logger.info(`Generating prompt variations...`);
      const { prompts: newPrompts, error } = await generatePrompts(testSuite.prompts[0].raw, 1);
      if (error || !newPrompts) {
        throw new Error(`Failed to generate prompts: ${error}`);
      }

      logger.info(chalk.blue('Generated prompts:'));
      let numAdded = 0;
      for (const prompt of newPrompts) {
        logger.info('--------------------------------------------------------');
        logger.info(`${prompt}`);
        logger.info('--------------------------------------------------------');

        // Ask the user if they want to continue
        await new Promise((resolve) => {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          rl.question(
            `${chalk.blue('Do you want to test this prompt?')} (y/N): `,
            async (answer) => {
              rl.close();
              if (answer.toLowerCase().startsWith('y')) {
                testSuite.prompts.push({ raw: prompt, display: prompt });
                numAdded++;
              } else {
                logger.info('Skipping this prompt.');
              }
              resolve(true);
            },
          );
        });
      }

      if (numAdded < 1) {
        logger.info(chalk.red('No prompts selected. Aborting.'));
        process.exit(1);
      }
    }

    // Split prompts by provider
    for (const prompt of testSuite.prompts) {
      for (const provider of testSuite.providers) {
        // Check if providerPromptMap exists and if it contains the current prompt's display
        if (testSuite.providerPromptMap) {
          const allowedPrompts = testSuite.providerPromptMap[provider.id()];
          if (allowedPrompts && !allowedPrompts.includes(prompt.display)) {
            continue;
          }
        }
        const updatedDisplay =
          testSuite.providers.length > 1 ? `[${provider.id()}] ${prompt.display}` : prompt.display;
        prompts.push({
          ...prompt,
          id: sha256(typeof prompt.raw === 'object' ? JSON.stringify(prompt.raw) : prompt.raw),
          display: updatedDisplay,
          metrics: {
            score: 0,
            testPassCount: 0,
            testFailCount: 0,
            assertPassCount: 0,
            assertFailCount: 0,
            totalLatencyMs: 0,
            tokenUsage: {
              total: 0,
              prompt: 0,
              completion: 0,
              cached: 0,
            },
            namedScores: {},
          },
        });
      }
    }

    // Aggregate all vars across test cases
    let tests =
      testSuite.tests && testSuite.tests.length > 0
        ? testSuite.tests
        : testSuite.scenarios
        ? []
        : [
            {
              // Dummy test for cases when we're only comparing raw prompts.
            },
          ];

    // Build scenarios and add to tests
    if (testSuite.scenarios && testSuite.scenarios.length > 0) {
      for (const scenario of testSuite.scenarios) {
        for (const data of scenario.config) {
          // Merge defaultTest with scenario config
          const scenarioTests = (
            scenario.tests || [
              {
                // Dummy test for cases when we're only comparing raw prompts.
              },
            ]
          ).map((test) => {
            return {
              ...testSuite.defaultTest,
              ...data,
              ...test,
              vars: {
                ...testSuite.defaultTest?.vars,
                ...data.vars,
                ...test.vars,
              },
              options: {
                ...testSuite.defaultTest?.options,
                ...test.options,
              },
            };
          });
          // Add scenario tests to tests
          tests = tests.concat(scenarioTests);
        }
      }
    }

    maybeEmitAzureOpenAiWarning(testSuite, tests);

    // Prepare vars
    const varNames: Set<string> = new Set();
    const varsWithSpecialColsRemoved: Record<string, string | string[] | object>[] = [];
    for (const testCase of tests) {
      if (testCase.vars) {
        const varWithSpecialColsRemoved: Record<string, string | string[] | object> = {};
        for (const varName of Object.keys(testCase.vars)) {
          varNames.add(varName);
          varWithSpecialColsRemoved[varName] = testCase.vars[varName];
        }
        varsWithSpecialColsRemoved.push(varWithSpecialColsRemoved);
      }
    }

    // Set up eval cases
    const runEvalOptions: RunEvalOptions[] = [];
    let rowIndex = 0;
    for (const testCase of tests) {
      // Handle default properties
      testCase.vars = { ...testSuite.defaultTest?.vars, ...testCase.vars };
      testCase.assert = [...(testSuite.defaultTest?.assert || []), ...(testCase.assert || [])];
      testCase.threshold = testCase.threshold ?? testSuite.defaultTest?.threshold;
      testCase.options = { ...testSuite.defaultTest?.options, ...testCase.options };

      const prependToPrompt =
        testCase.options?.prefix || testSuite.defaultTest?.options?.prefix || '';
      const appendToPrompt =
        testCase.options?.suffix || testSuite.defaultTest?.options?.suffix || '';

      // Finalize test case eval
      const varCombinations = generateVarCombinations(testCase.vars || {});

      const numRepeat = this.options.repeat || 1;
      for (let repeatIndex = 0; repeatIndex < numRepeat; repeatIndex++) {
        for (const vars of varCombinations) {
          let colIndex = 0;
          for (const prompt of testSuite.prompts) {
            for (const provider of testSuite.providers) {
              if (testSuite.providerPromptMap) {
                const allowedPrompts = testSuite.providerPromptMap[provider.id()];
                if (allowedPrompts && !allowedPrompts.includes(prompt.display)) {
                  // This prompt should not be used with this provider.
                  continue;
                }
              }
              runEvalOptions.push({
                delay: options.delay || 0,
                provider,
                prompt: {
                  ...prompt,
                  raw: prependToPrompt + prompt.raw + appendToPrompt,
                },
                test: { ...testCase, vars, options: testCase.options },
                nunjucksFilters: testSuite.nunjucksFilters,
                includeProviderId: testSuite.providers.length > 1,
                rowIndex,
                colIndex,
                repeatIndex,
              });
              colIndex++;
            }
          }
          rowIndex++;
        }
      }
    }

    // Set up table...
    const isTest = tests.some((t) => !!t.assert);

    const table: EvaluateTable = {
      head: {
        prompts,
        vars: Array.from(varNames).sort(),
        // TODO(ian): add assertions to table?
      },
      body: [],
    };

    // Determine run parameters
    let concurrency = options.maxConcurrency || DEFAULT_MAX_CONCURRENCY;
    const usesConversation = prompts.some((p) => p.raw.includes('_conversation'));
    if (usesConversation && concurrency > 1) {
      logger.info(
        `Setting concurrency to 1 because the ${chalk.cyan('_conversation')} variable is used.`,
      );
      concurrency = 1;
    }

    // Start the progress bar...
    let progressbar: SingleBar | undefined;
    if (options.showProgressBar) {
      const cliProgress = await import('cli-progress');
      progressbar = new cliProgress.SingleBar(
        {
          format:
            'Eval: [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} | {provider} "{prompt}" {vars}',
        },
        cliProgress.Presets.shades_classic,
      );
      progressbar.start(runEvalOptions.length, 0, {
        provider: '',
        prompt: '',
        vars: '',
      });
    }
    if (options.progressCallback) {
      options.progressCallback(0, runEvalOptions.length);
    }

    // Actually run the eval
    const results: EvaluateResult[] = [];
    await async.forEachOfLimit(
      runEvalOptions,
      concurrency,
      async (evalStep: RunEvalOptions, index: number | string) => {
        const row = await this.runEval(evalStep);

        results.push(row);

        if (progressbar) {
          progressbar.increment({
            provider: evalStep.provider.id(),
            prompt: evalStep.prompt.raw.slice(0, 10).replace(/\n/g, ' '),
            vars: Object.entries(evalStep.test.vars || {})
              .map(([k, v]) => `${k}=${v}`)
              .join(' ')
              .slice(0, 10)
              .replace(/\n/g, ' '),
          });
        }
        if (options.progressCallback) {
          options.progressCallback(results.length, runEvalOptions.length);
        }

        // Bookkeeping for table
        if (typeof index !== 'number') {
          throw new Error('Expected index to be a number');
        }

        let resultText: string | undefined;
        const outputTextDisplay =
          typeof row.response?.output === 'object'
            ? JSON.stringify(row.response.output)
            : row.response?.output || null;
        if (isTest) {
          if (row.success) {
            resultText = `${outputTextDisplay || row.error || ''}`;
          } else {
            resultText = `${row.error}\n---\n${outputTextDisplay || ''}`;
          }
        } else if (row.error) {
          resultText = `${row.error}`;
        } else {
          resultText = outputTextDisplay || row.error || '';
        }

        const { rowIndex, colIndex } = evalStep;
        if (!table.body[rowIndex]) {
          table.body[rowIndex] = {
            description: evalStep.test.description,
            outputs: [],
            vars: table.head.vars
              .map((varName) => {
                const varValue = evalStep.test.vars?.[varName] || '';
                if (typeof varValue === 'string') {
                  return varValue;
                }
                if (Array.isArray(varValue)) {
                  // Only flatten string arrays
                  return typeof varValue[0] === 'string' ? varValue : JSON.stringify(varValue);
                }
                return JSON.stringify(varValue);
              })
              .flat(),
          };
        }
        table.body[rowIndex].outputs[colIndex] = {
          pass: row.success,
          score: row.score,
          namedScores: row.namedScores,
          text: resultText,
          prompt: row.prompt.raw,
          provider: row.provider.id,
          latencyMs: row.latencyMs,
          tokenUsage: row.response?.tokenUsage,
          gradingResult: row.gradingResult,
        };

        const metrics = table.head.prompts[colIndex].metrics;
        invariant(metrics, 'Expected prompt.metrics to be set');
        metrics.score += row.score;
        for (const [key, value] of Object.entries(row.namedScores)) {
          metrics.namedScores[key] = (metrics.namedScores[key] || 0) + value;
        }
        metrics.testPassCount += row.success ? 1 : 0;
        metrics.testFailCount += row.success ? 0 : 1;
        metrics.assertPassCount +=
          row.gradingResult?.componentResults?.filter((r) => r.pass).length || 0;
        metrics.assertFailCount +=
          row.gradingResult?.componentResults?.filter((r) => !r.pass).length || 0;
        metrics.totalLatencyMs += row.latencyMs || 0;
        metrics.tokenUsage.cached =
          (metrics.tokenUsage.cached || 0) + (row.response?.tokenUsage?.cached || 0);
        metrics.tokenUsage.completion += row.response?.tokenUsage?.completion || 0;
        metrics.tokenUsage.prompt += row.response?.tokenUsage?.prompt || 0;
        metrics.tokenUsage.total += row.response?.tokenUsage?.total || 0;
      },
    );

    if (progressbar) {
      progressbar.stop();
    }
    if (options.progressCallback) {
      options.progressCallback(runEvalOptions.length, runEvalOptions.length);
    }

    telemetry.record('eval_ran', {
      numPrompts: prompts.length,
      numTests: tests.length,
      numVars: varNames.size,
      numProviders: testSuite.providers.length,
    });

    return { version: 2, results, stats: this.stats, table };
  }
}

export function evaluate(testSuite: TestSuite, options: EvaluateOptions) {
  const ev = new Evaluator(testSuite, options);
  return ev.evaluate();
}
