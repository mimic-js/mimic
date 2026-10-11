if (!['public-spawn', 'public-stdin'].includes(process.env.PRETTIER_RECEIPT)) throw new Error('missing receipt env');
if (process.cwd() !== '/home/prettier-3-9-5') throw new Error(`unexpected cwd ${process.cwd()}`);
if (!process.argv.some((argument) => argument.includes('prettier'))) throw new Error(`unexpected argv ${JSON.stringify(process.argv)}`);
if (!process.env.PATH?.includes('/home/prettier-3-9-5/node_modules/.bin')) throw new Error('missing bin path');
module.exports = { singleQuote: true, semi: false };
