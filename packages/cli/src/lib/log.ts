const orange = "\x1b[38;5;208m";
const green = "\x1b[32m";
const red = "\x1b[31m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";
const bold = "\x1b[1m";

export const log = {
  info: (msg: string) => console.log(`${dim}→${reset} ${msg}`),
  success: (msg: string) => console.log(`${green}✓${reset} ${msg}`),
  error: (msg: string) => console.error(`${red}✗${reset} ${msg}`),
  warn: (msg: string) => console.log(`${orange}!${reset} ${msg}`),
  header: (msg: string) => console.log(`\n${bold}${orange}${msg}${reset}\n`),
  dim: (msg: string) => console.log(`  ${dim}${msg}${reset}`),
  blank: () => console.log(),
};
