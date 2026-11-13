'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { IMAGE_PROMPT, PROMPT_WRITER, sniffImage, parseImageResponse, createImageMaker } = require('../lib/learn-image');
const { LearnError } = require('../lib/learn-names');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
const JPG = Buffer.from('ffd8ffe000104a464946', 'hex');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const dataUrl = (buf, type = 'png') => `data:image/${type};base64,${buf.toString('base64')}`;
const KEY = 'sk-or-v1-abcdefgh1234';

const okBody = (over = {}) => ({
  model: 'some/model-picked',
  usage: { cost: 0.0412 },
  output: [
    { type: 'image_generation_call', status: 'completed', result: dataUrl(PNG) },
    { type: 'message', content: [{ type: 'output_text', text: '"Cache layers explained."' }] },
  ],
  ...over,
});

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    return handler(url, opts, calls.length);
  };
  return { f, calls };
}
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const is502 = (message) => (e) => e instanceof LearnError && e.status === 502 && e.message === message;

test('IMAGE_PROMPT is the fixed copy, with the focus in the second sentence', () => {
  assert.equal(IMAGE_PROMPT('abc', ''), 'Make one clear explainer image for someone studying the material below. Show its main idea as a labelled diagram or infographic: a few short labels, arrows or groupings where they help, a flat clean style on a plain background, no decorative text and no logos. Then reply with a short title for the image, at most six words, and nothing else.\n\nMaterial:\n<<<\nabc\n>>>');
  assert.match(IMAGE_PROMPT('abc', '  how layers connect '), /^Make one clear explainer image for someone studying the material below\. Show how layers connect as a labelled diagram or infographic:/);
});

test('sniffImage knows PNG, JPEG and WebP and nothing else', () => {
  assert.equal(sniffImage(PNG), 'png');
  assert.equal(sniffImage(JPG), 'jpg');
  assert.equal(sniffImage(WEBP), 'webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns=')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test('parseImageResponse finds the image, the title, the model and the cost', () => {
  const r = parseImageResponse(okBody());
  assert.equal(r.b64, PNG.toString('base64'));
  assert.equal(r.title, 'Cache layers explained');
  assert.equal(r.model, 'some/model-picked');
  assert.equal(r.cost, 0.0412);
  assert.equal(parseImageResponse(okBody({ usage: {} })).cost, null);
  const viaUrl = okBody({ output: [{ type: 'image_generation_call', imageUrl: dataUrl(PNG) }] });
  assert.equal(parseImageResponse(viaUrl).title, 'image');
  const long = okBody({ output: [okBody().output[0], { type: 'message', content: [{ type: 'output_text', text: `Title: **${'word '.repeat(30)}**` }] }] });
  assert.ok(parseImageResponse(long).title.length <= 60);
  assert.ok(!/^Title|\*/.test(parseImageResponse(long).title));
});

test('parseImageResponse without an image is a 502', () => {
  assert.throws(() => parseImageResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'no' }] }] }), is502('OpenRouter answered without an image.'));
  assert.throws(() => parseImageResponse({}), is502('OpenRouter answered without an image.'));
});

test('make: one call to the Responses API with the auto router and the image tool, no image model named', async () => {
  const { f, calls } = fakeFetch(() => reply(okBody()));
  const maker = createImageMaker({ fetch: f });
  const r = await maker.make({ key: KEY, text: 'the notes', focus: '' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/responses');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(calls[0].body, { model: 'openrouter/auto', input: IMAGE_PROMPT('the notes', ''), tools: [{ type: 'openrouter:image_generation' }] });
  assert.deepEqual(r.bytes, PNG);
  assert.equal(r.ext, 'png');
  assert.equal(r.title, 'Cache layers explained');
  assert.equal(r.model, 'some/model-picked');
  assert.equal(r.cost, 0.0412);
});

test('make with a fallback model: auto writes the prompt, then the fallback model draws it', async () => {
  const { f, calls } = fakeFetch((url, opts, n) => (n === 1
    ? reply({ model: 'auto/picked', usage: { cost: 0.001 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'A labelled diagram of X.' }] }] })
    : reply(okBody({ model: 'small/model', usage: { cost: 0.04 } }))));
  const maker = createImageMaker({ fetch: f, baseUrl: 'http://127.0.0.1:9/api/v1', fallbackModel: 'small/model' });
  const r = await maker.make({ key: KEY, text: 'the notes', focus: 'X' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://127.0.0.1:9/api/v1/responses');
  assert.deepEqual(calls[0].body, { model: 'openrouter/auto', input: PROMPT_WRITER('the notes', 'X') });
  assert.equal(calls[1].body.model, 'small/model');
  assert.deepEqual(calls[1].body.tools, [{ type: 'openrouter:image_generation' }]);
  assert.match(calls[1].body.input, /^A labelled diagram of X\.\n\nThen reply with a short title for the image, at most six words, and nothing else\.$/);
  assert.equal(r.model, 'small/model');
  assert.ok(Math.abs(r.cost - 0.041) < 1e-9);
});

test('make: bytes that are not an image are refused', async () => {
  const { f } = fakeFetch(() => reply(okBody({ output: [{ type: 'image_generation_call', result: dataUrl(Buffer.from('<svg onload=x>'), 'svg+xml') }] })));
  await assert.rejects(createImageMaker({ fetch: f }).make({ key: KEY, text: 't', focus: '' }), is502('OpenRouter sent something that isn\'t an image.'));
});

test('make: OpenRouter errors become one plain line, always a 502 to the browser', async () => {
  const cases = [
    [401, 'OpenRouter rejected the key. Check it in Settings → Learn.'],
    [402, 'Your OpenRouter account is out of credit.'],
    [403, 'The image model refused this. Try different wording in "What should it show?".'],
    [429, 'OpenRouter is busy. Try again in a minute.'],
    [500, 'OpenRouter couldn\'t make the image (error 500).'],
  ];
  for (const [status, message] of cases) {
    const { f } = fakeFetch(() => reply({ error: { message: 'x' } }, status));
    await assert.rejects(createImageMaker({ fetch: f }).make({ key: KEY, text: 't', focus: '' }), is502(message), String(status));
  }
});

test('make: an image the model refused (moderation) says so', async () => {
  const { f } = fakeFetch(() => reply(okBody({ output: [{ type: 'image_generation_call', status: 'error', error: { message: 'Request blocked by the safety system' } }] })));
  await assert.rejects(createImageMaker({ fetch: f }).make({ key: KEY, text: 't', focus: '' }),
    is502('The image model refused this. Try different wording in "What should it show?".'));
});

test('make: a timeout and an unreachable OpenRouter', async () => {
  const hang = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(createImageMaker({ fetch: hang, timeoutMs: 30 }).make({ key: KEY, text: 't', focus: '' }),
    (e) => e instanceof LearnError && e.status === 504 && e.message === 'OpenRouter took too long (2 minutes).');
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(createImageMaker({ fetch: down }).make({ key: KEY, text: 't', focus: '' }), is502('Couldn\'t reach OpenRouter.'));
});

test('testKey reads the key endpoint, spending nothing', async () => {
  const { f, calls } = fakeFetch(() => reply({ data: { limit_remaining: 4.2 } }));
  assert.deepEqual(await createImageMaker({ fetch: f }).testKey(KEY), { ok: true, credit: 4.2 });
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/key');
  assert.equal(calls[0].opts.method || 'GET', 'GET');
  const none = fakeFetch(() => reply({ data: { limit_remaining: null } }));
  assert.deepEqual(await createImageMaker({ fetch: none.f }).testKey(KEY), { ok: true, credit: null });
  const bad = fakeFetch(() => reply({ error: {} }, 401));
  await assert.rejects(createImageMaker({ fetch: bad.f }).testKey(KEY), is502('OpenRouter rejected the key. Check it in Settings → Learn.'));
});
