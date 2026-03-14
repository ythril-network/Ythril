import bcrypt from './node_modules/bcrypt/bcrypt.js';
import { randomBytes } from 'crypto';
const token = 'ythril_test_' + randomBytes(16).toString('hex');
const hash = await bcrypt.hash(token, 12);
console.log('TOKEN=' + token);
console.log('HASH=' + hash);
