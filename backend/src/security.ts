import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve,reject) => {
  scrypt(password,salt,64,{ N:65536,r:8,p:2,maxmem:128*1024*1024 },(error,key)=>error ? reject(error) : resolve(key));
});
export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [salt, key] = hash.split(':');
  if (!salt || !key) return false;
  const actual = await derive(password, salt);
  const expected = Buffer.from(key, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
