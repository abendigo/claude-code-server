// Message sequences shaped like what the bridge really emits (recorded from a
// live session, trimmed and with paths made generic).
const sdk = (message) => ({ type: 'sdk', message });
const ev = (event) => sdk({ type: 'stream_event', event, parent_tool_use_id: null });

export const init = sdk({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'test-model', cwd: '/workspace/proj' });

export const reply = (id, text) => [
  ev({ type: 'message_start', message: { id } }),
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ...text.split(' ').map((w, i) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: (i ? ' ' : '') + w } })),
  sdk({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text }] } }),
  ev({ type: 'content_block_stop', index: 0 }),
];

export const toolUse = (id, name, input) => [
  ev({ type: 'message_start', message: { id: 'm-' + id } }),
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }),
  sdk({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm-' + id, content: [{ type: 'tool_use', id, name, input }] } }),
  ev({ type: 'content_block_stop', index: 0 }),
];

export const toolResult = (id, content, isError = false) =>
  sdk({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

export const thinking = sdk({ type: 'assistant', parent_tool_use_id: null, message: { id: 'th', content: [{ type: 'thinking', thinking: '' }] } });
export const result = (extra = {}) => sdk({ type: 'result', subtype: 'success', duration_ms: 4321, total_cost_usd: 0.01, ...extra });

export const permissionRequest = (id, tool, input) => ({ type: 'permission_request', id, tool, input, displayName: tool });
