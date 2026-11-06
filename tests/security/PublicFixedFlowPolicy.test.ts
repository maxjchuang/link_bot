import { expect, it } from 'vitest';
import { classifyPublicFixedFlow } from '../../src/security/PublicFixedFlowPolicy.js';
import { sampleConfig } from '../helpers/fakes.js';

it('does not grant delegated workflow access to arbitrary requesters', () => {
  expect(classifyPublicFixedFlow(sampleConfig('/tmp/project'), {
    chatId: 'oc_1', chatType: 'group', text: '@bot https://github.com/example/project/pull/1', wasMentioned: true,
  })).toBeUndefined();
});
