import type { TObject, TRecord, TString, TUnknown } from 'typebox';

// Plain JSON schemas keep the bootstrap independent of replaceable dependencies.
export const gatewayTools = {
  discover: {
    name: 'gateway_tools', label: 'Gateway tools',
    description: 'Discover local gateway tools and their input schemas.',
    parameters: { type: 'object', properties: {} } as TObject<{}>,
  },
  call: {
    name: 'gateway_call', label: 'Gateway call',
    description: 'Call a local gateway tool; use gateway_tools to discover names and schemas. Required confirmations go directly to the user.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, arguments: { type: 'object', patternProperties: { '^.*$': {} } } },
      required: ['name', 'arguments'],
    } as unknown as TObject<{ name: TString; arguments: TRecord<string, TUnknown> }>,
  },
};

export const gatewayCommands = {
  gateway: 'Open gateway services, packages and connection menus. No model turn.',
  'pi-services': 'Open this gateway’s Services menu. No model turn.',
};
