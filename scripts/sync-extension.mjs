// Copies the shared Coupa filler into the Chrome extension so the bookmarklet
// and the extension always run the same code. Runs before every build.
import { copyFileSync } from 'node:fs';

copyFileSync('public/coupa-filler.js', 'coupa-extension/coupa-filler.js');
