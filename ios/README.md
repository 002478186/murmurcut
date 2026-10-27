# murmurcut for iPhone

The web app bundled in a native shell. The app serves it from `http://127.0.0.1:8723` (ES modules, workers and
WebCodecs need a real origin) and adds a share sheet for exports, a reload after iOS kills the page for memory, and
an awake screen while it works.

GitHub Actions builds it on every push (`.github/workflows/ios.yml`) and uploads `Murmurcut-unsigned.ipa`.
Install it from Windows with [xtool](https://github.com/xtool-org/xtool), signed with a free Apple ID (it expires
after 7 days, so install it again to refresh):

```bash
xtool install Murmurcut-unsigned.ipa
```
