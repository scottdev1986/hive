#!/usr/bin/env bun

import { Command } from "commander";

const notImplemented = (): void => {
  console.log("not implemented");
};

const program = new Command();

program.name("hive");

program.command("claude").action(notImplemented);
program.command("codex").action(notImplemented);
program.command("status").action(notImplemented);
program.command("watch <agent>").action(notImplemented);
program.command("stop").action(notImplemented);
program.command("event <name>").action(notImplemented);

program.parse();
