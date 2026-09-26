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

const elementor = {
  layers: [
    { name: 'div.elementor-element.e-con' },
    { name: 'div.elementor-widget-container' },
  ],
};
assert.equal(frameworkOf(elementor), 'elementor');
assert.equal(frameworkOf({ layers: [], elementorPreflight: { detected: true } }), 'elementor');
assert.equal(frameworkOf({ layers: [{ name: 'div.t-rec' }, { name: 'div.t396' }] }), 'tilda');
console.log('PASS Webflow class fragments cannot be mistaken for Elementor');
