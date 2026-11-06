# Changelog

## 1.0.1
- Any GM writes its own entries directly. Before, a second GM's entries waited for the active GM and were lost if that GM's browser had the logger off.
- Player entries go to every GM; one GM writes them, chosen among GMs that announced they run usedtp Logger.
- Queued entries are resent as soon as a GM running the logger connects.
- Error notice from guard now says what happened: Logged, Sent to the GM, Saved on this computer, or Not saved. It no longer says "Logged for the GM" when nothing was saved.
- Viewer drops repeated entry ids.
- Added Node tests.

## 1.0.0
- First release: shared file log, socket delivery with offline queue, Error/Unclear reports, GM log viewer with status and export.
