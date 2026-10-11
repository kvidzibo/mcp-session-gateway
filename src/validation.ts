import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats, { type FormatsPlugin } from 'ajv-formats';

/** Each service schema gets its own registry; schemas may reuse the same $id. */
export function compileSchema(schema: object): (value: unknown) => string | undefined {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  (addFormats as unknown as FormatsPlugin)(ajv);
  const valid = ajv.compile(schema);
  return (value) => valid(value) ? undefined : ajv.errorsText(valid.errors);
}
