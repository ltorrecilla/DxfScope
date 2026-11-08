# Editor command profiles

English (`en.json`) is the default base profile. Profiles change typed command aliases; they do not translate the interface or modify DXF data. English aliases remain available in every profile.

## Create a profile

1. Find canonical command IDs in `en.json`. These are the registry's `tool` values, including action IDs such as `create-block` and `plot`. Do not use translated labels as IDs or change the canonical actions.
2. Create `<id>.json` in this directory. Use a lowercase ID such as `es` or `es-custom`: a letter followed by lowercase letters/digits, optionally separated by single hyphens, at most 64 characters. Use a meaningful display name.
3. Add aliases only for commands you want to customize. Omitted commands retain their English aliases. Each supplied command needs a nonempty array of strings.
4. Add `{ "id": "...", "name": "...", "file": "<id>.json" }` to `manifest.json`. Keep English first. IDs and filenames must be unique; names must match the profile. Files must be in this directory, with no URL or directory components.
5. Run the validation tests below and explain the vocabulary and abbreviation choices in your PR. A native speaker or experienced CAD user should review real language packs.

Minimal Spanish schema example (a subset of the shipped profile):

```json
{
  "schemaVersion": 1,
  "id": "es",
  "name": "Español",
  "commands": {
    "line": ["LINEA", "LÍNEA"],
    "move": ["MOVER"]
  }
}
```

This illustrates the schema, not a complete or vendor-compatible Spanish command set. No JavaScript, callbacks, URLs or extra fields belong in a profile.

## Alias rules

- Normalize by trimming, Unicode NFC, locale-independent uppercase, then NFC. Case and decomposed/composed accents match; accents are not removed. Add accented and unaccented forms explicitly if both should work.
- Start with a Unicode letter; subsequent characters can be letters, combining marks or decimal digits. Maximum: 64 normalized code points. Internal whitespace, punctuation, control/invisible characters, numeric-only aliases and coordinate syntax are rejected.
- All English aliases are protected. `L` already means Line, so assigning `L` to Move fails. Reusing `LINE` for Line is allowed and deduplicated in the effective list.
- Duplicate normalized aliases within a profile fail, including aliases assigned to different commands. Use another spelling; do not depend on ordering to override a conflict.
- Tool options have priority while a tool is running. For example, Polygon `C` remains its option; idle `C` remains Circle. Keyboard shortcuts, numeric/coordinate input and Space repetition are not defined by profiles.

Validation errors include a code, profile ID, command ID, alias, normalized token and conflicting owner where applicable. Common codes include `unknown-command`, `invalid-alias`, `duplicate-alias`, `local-conflict`, `english-conflict`, `id-mismatch` and `english-parity`. A failed compilation exposes no partial map.

## Validate from the repository root

```sh
node --test tests/dxf-editor-command-language.test.cjs tests/dxf-editor-command-profiles.test.cjs
node --test --test-reporter=dot tests/dxf-*.test.cjs
```

The profile test automatically reads every manifest entry, checks its schema and collisions, protects English fallback, and detects unregistered JSON files. A manifest entry is required for a contributor profile to join this validation set. Neither command changes drawings or activates profiles.

## Maintain the English base

The built-in command registry in `../dxf-editor-commands.js` is authoritative and remains the recovery path if profile loading fails. `en.json` must match every canonical command and alias, including alias order. When adding a real command, update the registry and English JSON together; the parity test catches drift. Do not add contributor-only aliases to English to avoid a conflict.

Runtime fallback, atomic activation and preference behavior are specified in [the architecture design](../../../../md/dxf-architecture.md#l1-command-language-profile-design-2026-11-02). Track implementation in [the roadmap](../../../../md/roadmap-dxf.md#phase-8-command-language-profiles).

## Shipped Spanish vocabulary

Select **Español** at the top of Editor Settings. The profile includes accented/unaccented forms such as `LÍNEA`/`LINEA`, `CÍRCULO`/`CIRCULO` and `POLÍGONO`/`POLIGONO`; `LI` starts Line, `MOVER`/`DESPLAZA` moves objects, and `RECORTA` trims. English aliases remain protected and available. `SPLINE` and `ZOOM` retain their familiar names. This is the project's Spanish vocabulary; it does not promise exact alias compatibility with other CAD applications. The profile changes command input, not interface language or active-tool option letters.
