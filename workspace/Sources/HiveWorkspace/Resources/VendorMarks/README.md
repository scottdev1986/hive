# Vendor marks

Official monochrome brand glyphs, rendered as template images tinted to
`labelColor` so they read correctly in light and dark (spec §12). Each mark is
the vendor's own logo shape, not a redrawn approximation. The marks remain
trademarks of their owners; they are used here to identify the vendors' own
CLIs inside the Model Control Center.

| File | Vendor | Source fetched from |
| --- | --- | --- |
| `anthropic.svg` | Anthropic | Simple Icons CDN (`cdn.simpleicons.org/anthropic`), the official Anthropic logogram |
| `openai.svg` | OpenAI | svgl brand library (`svgl.app/library/openai.svg`), the official OpenAI blossom |
| `xai.svg` | xAI | Wikimedia Commons `XAI-Logo.svg`, the official xAI mark |

If a mark fails to load at runtime, `ProviderMarkView` falls back to an SF
Symbol plus the provider's text name — never a broken image frame.
