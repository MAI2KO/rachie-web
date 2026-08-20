import { createInterface } from "node:readline/promises";

import { runBookingConfigWizard } from "../server/bootstrap/booking-community-config.mjs";

const readline = createInterface({ input: process.stdin, output: process.stdout });

const prompter = {
  input: (question) => readline.question(question),
  message: (message) => process.stdout.write(`${message}\n`),
  async confirm(question, defaultValue = false) {
    const hint = defaultValue ? "Y/n" : "y/N";
    for (;;) {
      const answer = (await readline.question(`${question} [${hint}] `)).trim().toLowerCase();
      if (!answer) return defaultValue;
      if (["y", "yes"].includes(answer)) return true;
      if (["n", "no"].includes(answer)) return false;
      process.stdout.write("Please answer y or n.\n");
    }
  },
  async select(question, choices) {
    process.stdout.write(`${question}\n`);
    choices.forEach((choice, index) => process.stdout.write(`  ${index + 1}. ${choice.label}\n`));
    for (;;) {
      const answer = (await readline.question("Choose 1 or 2: ")).trim();
      const choice = choices[Number(answer) - 1];
      if (choice) return choice.value;
      process.stdout.write(`Please enter a number from 1 to ${choices.length}.\n`);
    }
  },
};

try {
  await runBookingConfigWizard({ prompter });
} catch (error) {
  process.stderr.write(`Could not create the configuration: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  readline.close();
}
