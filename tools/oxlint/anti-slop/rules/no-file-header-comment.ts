import { defineRule } from "@oxlint/plugins";

const DIRECTIVE =
	/^\s*(?:oxlint-|eslint-|biome-|prettier-|istanbul\s|c8\s|v8-|@ts-|spdx-license-identifier:|copyright\b|safety\s*:)/iu;

function skipShebang(text: string): number {
	if (!text.startsWith("#!")) return 0;
	const newline = text.indexOf("\n");
	return newline === -1 ? text.length : newline + 1;
}

function skipSpace(text: string, index: number): number {
	let current = index;
	while (current < text.length) {
		const char = text[current];
		if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") break;
		current += 1;
	}
	return current;
}

function lineCommentEnd(text: string, start: number): number {
	const newline = text.indexOf("\n", start);
	return newline === -1 ? text.length : newline + 1;
}

function blockCommentEnd(text: string, start: number): number {
	const close = text.indexOf("*/", start + 2);
	return close === -1 ? text.length : close + 2;
}

function hasLeadingFileDocs(text: string): boolean {
	let index = skipShebang(text);
	let found = false;
	while (index < text.length) {
		const atComment = skipSpace(text, index);
		if (text.startsWith("//", atComment)) {
			const end = lineCommentEnd(text, atComment);
			const value = text.slice(atComment + 2, end);
			if (DIRECTIVE.test(value)) {
				index = end;
				continue;
			}
			found = true;
			index = end;
			continue;
		}
		if (text.startsWith("/*", atComment)) {
			const end = blockCommentEnd(text, atComment);
			const inner = text.slice(atComment + 2, end - 2);
			if (DIRECTIVE.test(inner)) {
				index = end;
				continue;
			}
			found = true;
			index = end;
			continue;
		}
		break;
	}
	return found;
}

export const noFileHeaderCommentRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow documentation comments before the first statement. Directives and SAFETY comments may lead.",
		},
		messages: {
			fileHeader:
				"Do not put a documentation comment at the top of the file. Explain a non-obvious why next to the code that needs it.",
		},
	},
	createOnce(context) {
		return {
			Program(node) {
				if (hasLeadingFileDocs(context.sourceCode.getText())) {
					context.report({ node, messageId: "fileHeader" });
				}
			},
		};
	},
});
