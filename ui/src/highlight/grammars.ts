// refractor with the grammars Kestrel highlights (HIGHLIGHT_LANGUAGES in
// @kestrel/server/code-highlight), and nothing else. Loaded on its own (highlighter.ts imports it
// lazily), so the app starts without it and code is drawn plain until it is here.
import { refractor } from 'refractor/core';
import bash from 'refractor/bash';
import c from 'refractor/c';
import cpp from 'refractor/cpp';
import css from 'refractor/css';
import diff from 'refractor/diff';
import docker from 'refractor/docker';
import go from 'refractor/go';
import hcl from 'refractor/hcl';
import java from 'refractor/java';
import javascript from 'refractor/javascript';
import json from 'refractor/json';
import jsx from 'refractor/jsx';
import kotlin from 'refractor/kotlin';
import markdown from 'refractor/markdown';
import markup from 'refractor/markup';
import php from 'refractor/php';
import puppet from 'refractor/puppet';
import python from 'refractor/python';
import ruby from 'refractor/ruby';
import rust from 'refractor/rust';
import scss from 'refractor/scss';
import sql from 'refractor/sql';
import swift from 'refractor/swift';
import toml from 'refractor/toml';
import tsx from 'refractor/tsx';
import typescript from 'refractor/typescript';
import yaml from 'refractor/yaml';
import type { HastLike, HighlightLanguage } from '@kestrel/server/code-highlight';

// Each grammar registers the ones it builds on (tsx: jsx and typescript; cpp: c).
for (const grammar of [markup, css, javascript, jsx, typescript, tsx, json, bash, python, go, rust, swift, kotlin, java, c, cpp, ruby, php, scss, markdown, yaml, toml, sql, diff, docker, hcl, puppet]) refractor.register(grammar);

/** `code` highlighted as `language`: a hast tree whose texts are the code exactly. */
export const highlightTree = (code: string, language: HighlightLanguage): HastLike => refractor.highlight(code, language);

