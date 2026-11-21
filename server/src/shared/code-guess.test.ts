import { describe, expect, test } from 'vitest';
import { blockLanguage, guessLanguage } from './code-guess.ts';

const SAMPLES: Record<string, string> = {
  swift: `struct ContentView: View {
    @State private var count = 0

    var body: some View {
        Button("Tapped \\(count) times") { count += 1 }
    }
}`,
  python: `import os

def load(path):
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return f.read()`,
  typescript: `export interface User {
  id: string;
  name: string;
}

export const greet = (user: User): string => \`Hello \${user.name}\`;`,
  javascript: `const fs = require('fs');

function read(path) {
  const text = fs.readFileSync(path, 'utf8');
  console.log(text.length === 0);
  return text;
}`,
  tsx: `export function Row({ name }: { name: string }) {
  const label = name.trim();
  return <div className="row">{label}</div>;
}`,
  json: `{
  "name": "kestrel",
  "version": "0.0.18",
  "private": true
}`,
  bash: `#!/bin/bash
set -euo pipefail
cd "$HOME/Code"
git status --short | grep -v node_modules`,
  go: `package main

import "fmt"

func main() {
	value, err := load()
	if err != nil {
		fmt.Println(err)
	}
}`,
  rust: `use std::collections::HashMap;

pub fn count(words: &str) -> HashMap<String, usize> {
    let mut seen = HashMap::new();
    seen
}`,
  kotlin: `data class User(val name: String, val age: Int)

fun greet(user: User): String {
    return "Hello \${user.name}"
}`,
  java: `import java.util.List;

public class Main {
    public static void main(String[] args) {
        System.out.println("hi");
    }
}`,
  c: `#include <stdio.h>

int main(void) {
    printf("hi\\n");
    return 0;
}`,
  cpp: `#include <iostream>

int main() {
    std::cout << "hi" << std::endl;
}`,
  ruby: `require 'json'

def load(path)
  items = JSON.parse(File.read(path))
  items.each do |item|
    puts item
  end
end`,
  php: `<?php
$name = 'Matt';
echo "Hello $name";`,
  css: `.row {
  display: flex;
  padding: 4px 8px;
  color: #333;
}`,
  markup: `<!DOCTYPE html>
<html>
  <body><p>Hello</p></body>
</html>`,
  yaml: `apiVersion: v1
kind: Service
metadata:
  name: kestrel
  labels:
    app: kestrel`,
  sql: `SELECT id, name
FROM sessions
WHERE archived = 0
ORDER BY created_at DESC;`,
  diff: `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;`,
};

describe('guessing the language of code that names none', () => {
  test.each(Object.entries(SAMPLES))('reads %s', (language, code) => {
    expect(guessLanguage(code)).toBe(language);
  });

  test('a Swift function with no SwiftUI in it is still Swift', () => {
    expect(guessLanguage('func greet(name: String) -> String {\n    let greeting = "Hello, \\(name)"\n    return greeting\n}')).toBe('swift');
    expect(guessLanguage('guard let url = URL(string: path) else { return nil }\nlet data = try Data(contentsOf: url)')).toBe('swift');
  });

  test('prose, a line of output and too little to tell stay plain', () => {
    expect(guessLanguage('')).toBeNull();
    expect(guessLanguage('The build failed after the second step, so I stopped there.')).toBeNull();
    expect(guessLanguage('x = 1')).toBeNull();
    expect(guessLanguage('error: no such file or directory')).toBeNull();
  });
});

describe('the language a block is drawn in', () => {
  test('the named language wins; a name Kestrel does not know is plain, never guessed', () => {
    expect(blockLanguage('py', SAMPLES.swift!)).toBe('python');
    expect(blockLanguage('brainfuck', SAMPLES.swift!)).toBeNull();
  });

  test('a block that names none is guessed', () => {
    expect(blockLanguage(null, SAMPLES.swift!)).toBe('swift');
    expect(blockLanguage('', SAMPLES.python!)).toBe('python');
    expect(blockLanguage(null, 'hello there')).toBeNull();
  });
});
