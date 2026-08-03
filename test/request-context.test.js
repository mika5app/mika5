'use strict';

const assert = require('assert');
const {
  createRequestContext,
  shouldRenderRequestOutput,
  resolveRequestDestination,
  settleRequestOutput
} = require('../src/renderer/request-context');

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

async function run() {
  const writes = [];
  const renders = [];
  const visuals = [];
  let state = { chatId: 'chat-a', projectId: 'project-a', providerId: 'openai' };
  const context = createRequestContext({
    requestId: 'request-a',
    chatId: 'chat-a',
    projectId: 'project-a',
    providerId: 'openai',
    selectedModel: 'model-a',
    startedAt: 1
  });

  const response = deferred();
  const completion = settleRequestOutput({
    context,
    responsePromise: response.promise,
    currentState: () => state,
    persist: async (output, destination) => writes.push({ output, destination }),
    render: async (output, destination) => renders.push({ output, destination }),
    registerVisual: async (output, destination) => visuals.push({ output, destination })
  });
  await Promise.resolve();
  state = { chatId: 'chat-b', projectId: 'project-b', providerId: 'anthropic' };
  response.resolve({ message: 'answer', provider: 'openai', model: 'model-a' });
  await completion;

  assert.strictEqual(writes.length, 1, 'response must persist once');
  assert.strictEqual(writes[0].destination.chatId, 'chat-a', 'response persists in original chat');
  assert.strictEqual(writes[0].destination.projectId, 'project-a', 'response keeps original project');
  assert.strictEqual(writes[0].destination.providerId, 'openai', 'response keeps captured provider');
  assert.strictEqual(writes[0].destination.selectedModel, 'model-a', 'response keeps captured model');
  assert.strictEqual(renders.length, 0, 'response from A must not render in B');
  assert.strictEqual(visuals[0].destination.chatId, 'chat-a', 'terminal image memory uses original chat');

  const destination = resolveRequestDestination(context);
  assert.strictEqual(destination.chatId, 'chat-a', 'output-limit notice uses original chat');
  assert.strictEqual(destination.chatId, 'chat-a', 'conflict alternative uses original chat');
  assert.strictEqual(shouldRenderRequestOutput(context, state), false);

  const sameView = deferred();
  const visible = settleRequestOutput({
    context,
    responsePromise: sameView.promise,
    currentState: () => ({ chatId: 'chat-a', projectId: 'project-a' }),
    persist: async () => {},
    render: async () => renders.push({ visible: true })
  });
  sameView.resolve({ message: 'visible' });
  await visible;
  assert.strictEqual(renders.length, 1, 'original view renders completed output');

  console.log('Request context tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
