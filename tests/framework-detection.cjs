const assert = require('node:assert/strict');
const { frameworkOf } = require('../lib/render22')._test;

const webflow = {
  layers: [
    { name: 'div.scene-container' },
    { name: 'div.feature-content' },
    { name: 'div.image-container' },
    { name: 'div.page-content' },
  ],
};
assert.equal(frameworkOf(webflow), 'generic', 'ordinary Webflow classes must not trigger Elementor fixes');
assert.equal(frameworkOf({ ...webflow, siteSignals: { webflow: true } }), 'webflow', 'verified Webflow DOM markers select its profile');
assert.equal(frameworkOf({ ...webflow, siteSignals: { webflow: false } }), 'generic', 'similar class names are not sufficient');

const elementor = {
  layers: [
    { name: 'div.elementor-element.e-con' },
    { name: 'div.elementor-widget-container' },
  ],
};
assert.equal(frameworkOf(elementor), 'elementor');
assert.equal(frameworkOf({ layers: [], elementorPreflight: { detected: true } }), 'elementor');
assert.equal(frameworkOf({ layers: [{ name: 'div.t-rec' }, { name: 'div.t396' }] }), 'tilda');
assert.equal(frameworkOf({ layers: [{ name: 'div.t-rec' }, { name: 'div.t396' }], siteSignals: { webflow: true } }), 'tilda', 'builder-specific markup wins over stale signals');
console.log('PASS engine selection uses positive DOM evidence and protects the generic fallback');
