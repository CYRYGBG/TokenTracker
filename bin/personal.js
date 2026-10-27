#!/usr/bin/env node
// Dedicated entry point: never writes the official profile or replaces its bin.
process.env.TOKENTRACKER_PERSONAL = '1';
require('./tracker.js');
