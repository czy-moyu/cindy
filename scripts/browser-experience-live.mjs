/** Opt-in public, read-only experiment. Runs the real MCP/runtime on an already
 * authorized Cindy browser tab; candidate files live in a disposable directory.
 * Measures tool text and browser calls, not provider billing or model reasoning.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';

const opt = (name) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const sourceRoot = path.resolve(opt('source-root') ?? process.cwd());
const baselineRoot = opt('baseline-root');
const cdpUrl = opt('cdp-url');
const targetId = opt('target');
const output = opt('out');
if (!cdpUrl || !targetId || !output || !baselineRoot)
  throw new Error('需要 --cdp-url --target --out --baseline-root');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-experience-live-'));
process.env.XDT_BROWSER_RUNTIME_DIR = path.join(temp, 'runtime');
const report = {
  startedAt: new Date().toISOString(),
  sourceRoot,
  baselineRoot,
  calls: [],
  checks: {},
  scope: '真实生产 MCP 和浏览器运行时；无额外模型；工具文本不等于供应商账单',
};
let current;
let vite, baselineVite, disconnect;
const moduleAt = (file) => import(pathToFileURL(path.join(sourceRoot, file)).href);
const makeVite = (root) =>
  createServer({
    root,
    configFile: false,
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [], entries: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    logLevel: 'error',
  });
try {
  vite = await makeVite(sourceRoot);
  baselineVite = await makeVite(baselineRoot);
  const { registerBrowserTools } = await vite.ssrLoadModule(
    '/packages/lizi-mcps/src/browser/tools.ts',
  );
  const { registerBrowserTools: registerBaseline } = await baselineVite.ssrLoadModule(
    '/packages/lizi-mcps/src/browser/tools.ts',
  );
  const { BrowserToolRegistry } = await moduleAt(
    'packages/lizi-mcps/src/browser/tool-registry.ts',
  );
  const { RecipeSchema } = await vite.ssrLoadModule(
    '/packages/lizi-mcps/src/browser/recipe-loader.ts',
  );
  const { stepToRequest } = await vite.ssrLoadModule(
    '/packages/lizi-mcps/src/browser/recipe-runner.ts',
  );
  const { browserExperienceStore } = await vite.ssrLoadModule(
    '/apps/desktop/src/main/browser-recipes/experience.ts',
  );
  const { createBrowserControlRuntime } = await moduleAt(
    'packages/browser-control-runtime/src/runtime.ts',
  );
  ({ closePlaywrightBrowserConnection: disconnect } = await moduleAt(
    'packages/browser-control-runtime/src/_generated/extension/src/browser/pw-session.ts',
  ));
  const runtime = createBrowserControlRuntime({
    config: {
      browser: {
        enabled: true,
        attachOnly: true,
        defaultProfile: 'experience-live',
        profiles: {
          'experience-live': { cdpUrl, attachOnly: true, color: '#00D9C5' },
        },
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      },
    },
    logSink: () => {},
  });
  const observed = {
    call: async (req) => {
      const start = performance.now();
      const result = await runtime.call(req);
      current?.runtime.push({
        action: req.action,
        kind: req.request?.kind,
        ok: result.ok,
        ms: performance.now() - start,
      });
      if (current && req.action === 'snapshot') current.original = result;
      return result;
    },
  };
  const store = browserExperienceStore(path.join(temp, 'recipes'));
  let version = 0;
  // The live harness isolates recipe storage; the production host writer/loader
  // is separately exercised by its filesystem tests. Reload JSON on every call.
  const savedFile = path.join(temp, 'candidates.json');
  const readRecipes = async () => {
    try {
      return new Map(
        JSON.parse(await fs.readFile(savedFile, 'utf8')).map((recipe) => [
          recipe.id,
          RecipeSchema.parse(recipe),
        ]),
      );
    } catch (err) {
      if (err.code === 'ENOENT') return new Map();
      throw err;
    }
  };
  const deps = {
    getRuntime: () => observed,
    experienceStore: store,
    getUserRecipes: async () => ({
      recipes: await readRecipes(),
      siteGuides: new Map(),
      version: `experience-live-${version}`,
    }),
    saveUserRecipe: async ({ recipe }) => {
      const recipes = await readRecipes();
      recipes.set(recipe.id, recipe);
      await fs.writeFile(savedFile, JSON.stringify([...recipes.values()]));
      version++;
      return { ok: true };
    },
  };
  const fresh = (register = registerBrowserTools) => {
    const registry = new BrowserToolRegistry();
    register(registry, deps);
    return registry;
  };
  let registry = fresh();
  const baseline = fresh(registerBaseline);
  const call = async (phase, args, owner = registry, allowFailure = false) => {
    const row = { phase, args: { targetId, ...args }, runtime: [] };
    report.calls.push(row);
    current = row;
    const start = performance.now();
    const result = await owner.call('browser', row.args);
    row.ms = performance.now() - start;
    row.text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    row.result = JSON.parse(row.text);
    row.isError = Boolean(result.isError);
    current = undefined;
    if (!allowFailure) assert.notEqual(row.isError, true, row.text);
    return row;
  };

  const url = 'https://itch.io/search?q=sokoban';
  const opened = await call('automatic-discovery', {
    action: 'navigate',
    url,
    intent: 'search',
  });
  assert(opened.result.recipeSuggestions.some((recipe) => recipe.id === 'itch-search'));
  assert.equal(opened.runtime.length, 1);
  const again = await call('discovery-cache', {
    action: 'navigate',
    url,
    intent: 'search',
  });
  assert.equal(again.result.recipeSuggestions, undefined);
  report.checks.discoveryWithoutExtraBrowserCall = true;

  const recipe = JSON.parse(
    await fs.readFile(
      path.join(
        sourceRoot,
        'packages/lizi-mcps/src/browser/cindy-recipes/itch.io/itch-search.recipe.json',
      ),
      'utf8',
    ),
  );
  const readFn = recipe.steps
    .at(-1)
    .fn.replaceAll('{{query|js}}', 'sokoban')
    .replaceAll('{{limit|js}}', '5');
  const expected = [];
  for (let i = 0; i < 3; i++) {
    await call(`precise-${i}`, { action: 'navigate', url }, baseline);
    const precise = await call(
      `precise-${i}`,
      { action: 'act', request: { kind: 'evaluate', fn: readFn } },
      baseline,
    );
    assert.equal(precise.result.data.result.matched, true);
    expected.push(precise.result.data.result);
    const reuse = await call(`reuse-${i}`, {
      action: 'recipe',
      recipeId: 'itch-search',
      inputs: { query: 'sokoban', limit: 5 },
    });
    assert.deepEqual(reuse.result.output, expected.at(-1));
  }
  for (const [query, limit] of [
    ['picross', 3],
    ['nonogram', 4],
    ['cindybenchzzzznomatch20261027', 5],
  ]) {
    const run = await call('new-inputs', {
      action: 'recipe',
      recipeId: 'itch-search',
      inputs: { query, limit },
    });
    assert.equal(run.result.output.matched, true);
    assert.equal(run.result.output.count, query.startsWith('cindybench') ? 0 : limit);
  }
  report.checks.preciseAndRecipeEqual = true;
  report.checks.changedInputsAndEmpty = true;

  // A separate public flow has no bundled recipe: observe twice across fresh
  // MCP instances. Both use the same real host experience file.
  const quoteUrl = 'https://quotes.toscrape.com/search.aspx';
  const filterUrl = 'https://quotes.toscrape.com/filter.aspx';
  // Selectors were observed in the preceding public-site experiment. Check
  // the selected values and every quote rather than treating clicks as proof.
  const draft = {
    id: 'live-quote-search',
    access: 'read',
    match: ['quotes.toscrape.com'],
    description: '按作者和标签查询语录',
    inputs: { author: { required: true }, tag: { required: true } },
    steps: [
      { action: 'navigate', url: quoteUrl },
      { action: 'wait', selector: '#author', timeoutMs: 10000 },
      {
        action: 'select',
        selector: '#author',
        values: ['{{author}}'],
        guard: { url: quoteUrl, selector: '#author' },
      },
      {
        action: 'wait',
        fn: "() => location.pathname === '/filter.aspx' && document.querySelector('#author')?.value === '{{author|js}}' && [...(document.querySelector('#tag')?.options || [])].some(o=>o.value === '{{tag|js}}')",
        timeoutMs: 10000,
      },
      {
        action: 'select',
        selector: '#tag',
        values: ['{{tag}}'],
        guard: { url: filterUrl, selector: '#tag' },
      },
      {
        action: 'click',
        selector: "input[name='submit_button']",
        guard: { url: filterUrl, selector: "input[name='submit_button']" },
      },
      { action: 'wait', selector: '.results .quote', timeoutMs: 10000 },
      {
        action: 'evaluate',
        guard: { url: filterUrl, selector: '.results' },
        fn: "() => { const author=document.querySelector('#author').value, tag=document.querySelector('#tag').value; const rows=[...document.querySelectorAll('.results .quote')].map(q=>({text:q.querySelector('.content').textContent.trim(),author:q.querySelector('.author').textContent.trim(),tag:q.querySelector('.tag').textContent.trim()})); return {author,tag,rows,matched:author==='{{author|js}}' && tag==='{{tag|js}}' && rows.length>0 && rows.every(r=>r.author===author && r.tag===tag)}; }",
        as: 'result',
        expect: { equals: { matched: true } },
      },
    ],
    output: '{{result}}',
  };
  for (let i = 0; i < 2; i++) {
    registry = fresh();
    const inputs = i
      ? { author: 'J.K. Rowling', tag: 'choices' }
      : { author: 'Albert Einstein', tag: 'learning' };
    let read;
    for (const step of draft.steps)
      read = await call(`observe-${i}`, stepToRequest(step, inputs));
    assert.equal(read.result.data.result.matched, true);
    if (i === 1) assert(read.result.learningOpportunity);
  }
  report.checks.repetitionAcrossToolSessions = true;
  await call('learn-help', {
    action: 'recipeHelp',
    site: 'quotes.toscrape.com',
  });
  const save = await call('learn-candidate', {
    action: 'saveRecipe',
    site: 'quotes.toscrape.com',
    recipeDraft: draft,
    deferValidation: true,
  });
  assert.equal(save.result.state, 'candidate');
  assert.equal(save.runtime.length, 0);
  registry = fresh();
  const newInputs = { author: 'Albert Einstein', tag: 'music' };
  const use = await call('candidate-real-use', {
    action: 'recipe',
    recipeId: draft.id,
    inputs: newInputs,
  });
  assert.equal(use.result.ok, true);
  assert.equal(use.result.output.matched, true);
  assert.equal(use.result.output.tag, 'music');
  assert.equal((await readRecipes()).get(draft.id).validation.state, 'active');
  report.checks.candidateSavedWithoutReplayAndPromotedNextSession = true;
  report.experiences = await store.list('quotes.toscrape.com');

  // Fail one candidate guard, then do the permitted repair. Never write to the website.
  const broken = {
    ...draft,
    id: 'live-quote-broken',
    steps: draft.steps.map((step, i) =>
      i === draft.steps.length - 1
        ? { ...step, guard: { ...step.guard, selector: '#missing-for-test' } }
        : step,
    ),
  };
  await call('repair-setup', {
    action: 'saveRecipe',
    site: 'quotes.toscrape.com',
    recipeDraft: broken,
    deferValidation: true,
  });
  const failed = await call(
    'repair-failure',
    { action: 'recipe', recipeId: broken.id, inputs: newInputs },
    registry,
    true,
  );
  assert.equal(failed.result.failureKind, 'guard');
  assert.equal((await readRecipes()).get(broken.id).validation.state, 'suspended');
  await call('repair-observe', {
    action: 'snapshot',
    selector: 'form',
    refs: 'role',
    compact: true,
    maxChars: 3000,
  });
  const repaired = { ...draft, id: broken.id };
  assert.equal(
    (
      await call('repair-trial', {
        action: 'recipe',
        site: 'quotes.toscrape.com',
        recipeDraft: repaired,
        inputs: newInputs,
      })
    ).result.verified,
    true,
  );
  await call('repair-save', {
    action: 'saveRecipe',
    site: 'quotes.toscrape.com',
    recipeDraft: repaired,
  });
  report.checks.singleRepair = true;

  await call('digest-setup', { action: 'navigate', url });
  const snapshot = await call('digest', {
    action: 'snapshot',
    snapshotFormat: 'ai',
    refs: 'aria',
    maxChars: 160000,
  });
  assert(snapshot.result.fullResult);
  let offset = 0,
    full = '';
  do {
    const part = await call('digest-readback', {
      action: 'readResult',
      resultId: snapshot.result.fullResult.id,
      offset,
      maxChars: 24000,
    });
    assert.equal(part.runtime.length, 0);
    full += part.result.text;
    offset = part.result.nextOffset;
  } while (offset !== null);
  assert.deepEqual(JSON.parse(full), snapshot.original);
  report.checks.digestExactRoundTrip = true;
  report.digest = {
    originalText: JSON.stringify(snapshot.original),
    summaryText: snapshot.text,
    sha256: createHash('sha256').update(full).digest('hex'),
  };
  report.prompt = {};
  for (const [label, root] of [
    ['before', baselineRoot],
    ['after', sourceRoot],
  ]) {
    const workflow = await fs.readFile(
      path.join(root, 'packages/lizi-mcps/src/browser/prompts/rules/browser-workflow.md'),
      'utf8',
    );
    const author = await fs.readFile(
      path.join(root, 'packages/lizi-mcps/src/browser/prompts/rules/recipe-author.md'),
      'utf8',
    );
    report.prompt[label] = {
      workflow,
      author,
      common: label === 'before' ? workflow + author : workflow,
    };
  }
  report.finishedAt = new Date().toISOString();
} catch (err) {
  report.error = err.stack ?? String(err);
  process.exitCode = 1;
} finally {
  // Reporting and every cleanup are independent: one failure must not leak
  // the remaining connection, Vite server or temporary candidate directory.
  const cleanupErrors = [];
  for (const clean of [
    () => fs.writeFile(output, JSON.stringify(report, null, 2)),
    () => disconnect?.(),
    () => vite?.close(),
    () => baselineVite?.close(),
    () => fs.rm(temp, { recursive: true, force: true }),
  ]) {
    try {
      await clean();
    } catch (err) {
      cleanupErrors.push(String(err));
    }
  }
  if (cleanupErrors.length) {
    process.exitCode = 1;
    report.cleanupErrors = cleanupErrors;
  }
  console.log(
    JSON.stringify({
      output,
      checks: report.checks,
      error: report.error,
      cleanupErrors: report.cleanupErrors,
      calls: report.calls.length,
    }),
  );
}
