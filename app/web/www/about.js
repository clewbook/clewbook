// The About page is plain text; this only gives it the shared look's brand name and frame and tells the load guard that it started.
import { setup, markReady } from './ui.js';
setup('About', { netbar: false });
markReady();
