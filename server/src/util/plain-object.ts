/**
 * Reading a value someone else shaped as a plain object, and one key of it. Defined in `@ythril/schema` (`schema/src/plain-object.ts`,
 * with what it prevents) because the schema validator asks the same two questions; re-exported so the server asks them here.
 */
export { isPlainObject, ownValue } from '@ythril/schema/internal';
