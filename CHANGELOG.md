# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The package version is `0.1.0` in the [initial commit](https://github.com/XanderXML-Bit/label-verify/commit/e1c64e0) dated 2026-05-11. Changes are grouped under Unreleased until a version is tagged.

## [Unreleased]

### Added

- Compare beverage labels with declared application fields and check Government Warning text, capitalization, bold type, and size.
- Accept application files alongside label images. Pair batches by filename, application data, or manifest.
- Open a bundled sample directly from its URL. [#103](https://github.com/XanderXML-Bit/label-verify/pull/103)
- Export single and batch results for review.

### Changed

- Run the public demo on three recorded samples. [#85](https://github.com/XanderXML-Bit/label-verify/pull/85)
- Keep visitor files in the browser in the public demo and refuse uploads before parsing them. [#101](https://github.com/XanderXML-Bit/label-verify/pull/101)
- Clarify the prototype's purpose in the UI and site metadata. [#102](https://github.com/XanderXML-Bit/label-verify/pull/102)

### Fixed

- Keep the initial viewport in place while the mobile page loads. [#86](https://github.com/XanderXML-Bit/label-verify/pull/86)
- Keep separate batch entries for multiple iOS photos named `image.jpg`. [#57](https://github.com/XanderXML-Bit/label-verify/pull/57)
- Render uploaded PDFs in the packaged production build. [Fix production PDF rendering](https://github.com/XanderXML-Bit/label-verify/commit/c097840)

### Security

- Update dependencies to address known production advisories. [#80](https://github.com/XanderXML-Bit/label-verify/pull/80)
