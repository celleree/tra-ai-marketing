import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RevisionControls } from '@/components/creative-library/revision-controls';

// Exercise the real component's current event handlers without a browser dependency.
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as any[] }));
vi.mock('react', () => ({
  useState(initial: any) {
    const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: any) => { hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value; }];
  },
  useRef(initial: any) {
    const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
}));
vi.mock('react/jsx-runtime', () => ({ jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) }));
vi.mock('@/lib/company/creative-context', () => ({ readStoredRuntimeCompanyProfile: () => undefined }));
const render = () => {
  hooks.cursor = 0;
  const tree = RevisionControls({ creative: { id: `creative_${'a'.repeat(32)}`, identity: {}, planning: {},
    generationProvenance: {}, placement: 'SQUARE_1_1', format: 'direct-response' } as any, onSaved: vi.fn() });
  const nodes: any[] = [];
  const visit = (value: any) => { if (Array.isArray(value)) value.forEach(visit); else if (value?.props) { nodes.push(value); visit(value.props.children); } };
  visit(tree); return nodes;
};
const find = (type: string, test: (props: any) => boolean = () => true) => render().find(node => node.type === type && test(node.props))!;
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0;
  const values = new Map<string, string>();
  vi.stubGlobal('window', { sessionStorage: { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['EDIT', 'VARIATION', 'PLACEMENT'] as const)('fresh %s uses displayed A and preserves unresolved B through refresh', async operation => {
  const sent: Array<{ body: any; key: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    sent.push({ body: JSON.parse(init.body), key: init.headers['Idempotency-Key'] }); throw new Error('Lost response');
  }));
  const choose = (value: string) => {
    if (operation === 'EDIT') {
      if (!find('textarea')) find('button', p => p.children === 'Edit').props.onClick();
      find('textarea').props.onChange({ target: { value } });
    } else {
      find('select', p => ['REGENERATE', 'VARIATION', 'PLACEMENT'].includes(p.value)).props.onChange({ target: { value: operation } });
      if (operation === 'VARIATION') find('textarea').props.onChange({ target: { value } });
      else find('select', p => !['REGENERATE', 'VARIATION', 'PLACEMENT'].includes(p.value)).props.onChange({ target: { value } });
    }
  };
  const send = async (count: number, fresh = false) => {
    if (fresh) find('button', p => p.children === (operation === 'EDIT' ? 'Start a new paid edit' : 'Start a new paid version')).props.onClick();
    else find('form').props.onSubmit({ preventDefault() {} });
    await vi.waitFor(() => { expect(sent).toHaveLength(count); expect(find('p', p => p.role === 'alert')).toBeDefined(); });
  };
  const a = operation === 'PLACEMENT' ? 'PORTRAIT_4_5' : 'Instruction A';
  const b = operation === 'PLACEMENT' ? 'SQUARE_1_1' : 'Instruction B';
  choose(a); await send(1); choose(b); await send(2); choose(a); await send(3, true);
  expect(sent[2].body).toEqual(sent[0].body); expect(sent[2].key).not.toBe(sent[0].key);
  hooks.values = []; // Simulated refresh; session storage remains intact.
  choose(b); await send(4); expect(sent[3].body).toEqual(sent[1].body); expect(sent[3].key).toBe(sent[1].key);
});
