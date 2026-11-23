# Curriculum fixtures

The portable vault is an original short course on calibrating a sensor. Its example statuses belong to the sample. Copy the vault to an isolated directory before exercising editing, timer, attachment or migration workflows. Each entry in `checksums.json` records the SHA-256 digest of a portable fixture. The integrity test reads each file as bytes.

## Portable course

| File | Purpose |
| --- | --- |
| Learning Path | Ordered stages, entry notes and a project checkpoint |
| Programming Foundations | Programming stage entry and course navigation |
| Python | Executable example, related concept, documentation reference and exercises |
| Python Course Home | Course phase and a one-link lesson checkbox |
| 01 - Test a Prediction | Unmigrated lesson whose status comes from the course checkbox |
| Mathematics | Mathematics stage entry |
| Vectors | Mathematical notation, data table and resource |
| Dot Products | Display math, worked example and explicit prerequisite |
| Machine Learning | Machine learning stage entry |
| Linear Regression | In-progress reading with GFM, math, tip callout, aliased link, practice, project and grouped resources |
| Residual Analysis | Next topic with an advisory dependency and practical exercises |
| Project - Calibrate a Sensor | Project steps, optional stretch goal and builds relationships |
| Calibration References | Cross-topic resource collection, shared URLs and explicit teaches relationships |
| calibration.csv | Small, human-checkable table for the CSV viewer |
| calibration.ipynb | Two notebook cells and saved stdout that can be previewed without execution |

## Edge cases

| File | Purpose |
| --- | --- |
| cycle-a, cycle-b | Reciprocal prerequisites |
| missing-prereq | Reference to an absent topic |
| dup/Dup, dup2/Dup, ambiguous | Same basename, shortest-path preference and a path-qualified alias |
| invalid-yaml, unterminated | Invalid YAML and an unclosed frontmatter block |
| crlf, bom | Newline and UTF-8 prefix preservation across edits |
| unknown-status, project-unknown-status | Raw status outside the respective vocabularies |
| folder-link | A wiki-link to a directory |
| block-list, comments, anchors | Block-style list, quoted scalar with comments, and an unsupported semantic-patch construct |
| Gradient, Gradient.sync-conflict-… | Ordinary note and a Syncthing-style conflict copy |
| Gradient - extra | Topic note associated by frontmatter and folder, with Cyrillic text for search |

## Private compatibility samples

From the original planning checkout, run:

```sh
node scripts/prepare-private-fixtures.mjs /absolute/path/to/your/vault
```

A separate private plan can be passed as the second argument. The helper reads the T1.1 selection from that plan. It copies the 37 selected files byte-for-byte and verifies their digests. The helper opens source files read-only, rejects symlinks and publishes the verified copy under `.local/private-fixtures/<manifest-sha256>/vault/`. The adjacent private manifest records each filename, size and digest. Rerunning against the same bytes verifies the previous snapshot. Source edits produce a new snapshot. Keep all private samples and manifests in ignored local storage.
