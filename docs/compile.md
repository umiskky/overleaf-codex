# Compile

`olcx compile` asks Overleaf to compile the bound project and downloads the PDF.
The core workflow does not require local LaTeX.

## Default Compile

```bash
olcx compile
```

The default PDF output path is:

```text
build/overleaf/main.pdf
```

## PDF Path

```bash
olcx compile --pdf build/overleaf/main.pdf
```

Use `--pdf` when a project needs a different local preview path.

## Fast Fallback

`olcx compile` can use a fast/draft fallback when normal compilation times out.
For debugging, compare these modes:

```bash
olcx compile --disable-fast-fallback
olcx compile --fast-fallback-timeout 60000
```

When fallback produces the PDF, command output includes:

```text
Status:
fallback-success
Fallback: fast/draft
```

Treat that PDF as a recovery artifact, not a full normal compile result.

If both modes fail, inspect the compile output, fix the LaTeX source locally or
on Overleaf, run `olcx sync --dry-run`, and compile again.

## Troubleshooting

If the PDF is not updated, check the exact file path and timestamp:

```bash
olcx compile
ls -l build/overleaf/main.pdf
olcx status
```
