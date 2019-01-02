'use strict';

// https://github.com/mozilla/source-map/blob/master/lib/source-map-consumer.js

const path = require('path');
const { readFileSync } = require('fs');
const { ArraySet } = require('source-map/lib/array-set');
const binarySearch = require('source-map/lib/binary-search');
const util = require('source-map/lib/util');

const GREATEST_LOWER_BOUND = 1;

class Mapping {
  constructor() {
    this.generatedLine = 0;
    this.generatedColumn = 0;
    this.lastGeneratedColumn = null;
    this.source = null;
    this.originalLine = null;
    this.originalColumn = null;
    this.name = null;
  }
}

const wasm = (() => {
  const pathToWasm = path.resolve(__dirname, './node_modules/source-map/lib/mappings.wasm');
  const callbackStack = [];
  const module = new WebAssembly.Module(readFileSync(pathToWasm));
  const instance = new WebAssembly.Instance(module, {
    env: {
      mapping_callback(
        generatedLine,
        generatedColumn,

        hasLastGeneratedColumn,
        lastGeneratedColumn,

        hasOriginal,
        source,
        originalLine,
        originalColumn,

        hasName,
        name,
      ) {
        const mapping = new Mapping();
        // JS uses 1-based line numbers, wasm uses 0-based.
        mapping.generatedLine = generatedLine + 1;
        mapping.generatedColumn = generatedColumn;

        if (hasLastGeneratedColumn) {
          // JS uses inclusive last generated column, wasm uses exclusive.
          mapping.lastGeneratedColumn = lastGeneratedColumn - 1;
        }

        if (hasOriginal) {
          mapping.source = source;
          // JS uses 1-based line numbers, wasm uses 0-based.
          mapping.originalLine = originalLine + 1;
          mapping.originalColumn = originalColumn;

          if (hasName) {
            mapping.name = name;
          }
        }

        callbackStack[callbackStack.length - 1](mapping);
      },

      start_all_generated_locations_for() {},
      end_all_generated_locations_for() {},
      start_compute_column_spans() {},
      end_compute_column_spans() {},
      start_generated_location_for() {},
      end_generated_location_for() {},
      start_original_location_for() {},
      end_original_location_for() {},
      start_parse_mappings() {},
      end_parse_mappings() {},
      start_sort_by_generated_location() {},
      end_sort_by_generated_location() {},
      start_sort_by_original_location() {},
      end_sort_by_original_location() {},
    },
  });

  return {
    exports: instance.exports,
    withMappingCallback: (mappingCallback, f) => {
      callbackStack.push(mappingCallback);
      try {
        f();
      } finally {
        callbackStack.pop();
      }
    },
  };
})();

class BasicSourceMapConsumer {
  constructor(sourceMap, sourceMapURL) {
    const { mappings } = sourceMap;
    const sources = sourceMap.sources.map(String);
    const names = sourceMap.names || [];
    const sourceRoot = sourceMap.sourceRoot || null;
    const sourcesContent = sourceMap.sourcesConent || null;
    const file = sourceMap.file || null;

    this.url = sourceMapURL;
    this._sourceLookupCache = new Map();
    this._names = ArraySet.fromArray(names.map(String), true);
    this._sources = ArraySet.fromArray(sources, true);
    this._absoluteSources = ArraySet.fromArray(
      this._sources.toArray().map((s) => util.computeSourceURL(sourceRoot, s, sourceMapURL)),
      true,
    );
    this.sourceRoot = sourceRoot;
    this.sourcesContent = sourcesContent;
    this._mappings = mappings;
    this._sourceMapURL = undefined;
    this.file = file;
    this._computedColumnSpans = false;
    this._mappingsPtr = 0;
  }

  _getMappingsPtr() {
    if (this._mappingsPtr === 0) {
      this._parseMappings();
    }

    return this._mappingsPtr;
  }

  _parseMappings() {
    const aStr = this._mappings;
    const size = aStr.length;

    const mappingsBufPtr = wasm.exports.allocate_mappings(size);
    const mappingsBuf = new Uint8Array(wasm.exports.memory.buffer, mappingsBufPtr, size);
    for (let i = 0; i < size; i += 1) {
      mappingsBuf[i] = aStr.charCodeAt(i);
    }

    const mappingsPtr = wasm.exports.parse_mappings(mappingsBufPtr);

    if (!mappingsPtr) {
      const error = wasm.exports.get_last_error();
      let msg = `Error parsing mappings (code ${error}): `;

      // XXX: keep these error codes in sync with `fitzgen/source-map-mappings`.
      switch (error) {
        case 1:
          msg += 'the mappings contained a negative line, column, source index, or name index';
          break;
        case 2:
          msg += 'the mappings contained a number larger than 2**32';
          break;
        case 3:
          msg += 'reached EOF while in the middle of parsing a VLQ';
          break;
        case 4:
          msg += 'invalid base 64 character while parsing a VLQ';
          break;
        default:
          msg += 'unknown error code';
          break;
      }

      throw new Error(msg);
    }

    this._mappingsPtr = mappingsPtr;
  }

  originalPositionFor(args) {
    const needle = {
      generatedLine: args.line,
      generatedColumn: args.column,
    };

    if (needle.generatedLine < 1) {
      throw new Error('Line numbers must be >= 1');
    }

    if (needle.generatedColumn < 0) {
      throw new Error('Column numbers must be >= 0');
    }

    let bias = args.bias || GREATEST_LOWER_BOUND;
    if (bias == null) {
      bias = GREATEST_LOWER_BOUND;
    }

    let mapping;
    wasm.withMappingCallback((m) => {
      mapping = m;
    }, () => {
      wasm.exports.original_location_for(
        this._getMappingsPtr(),
        needle.generatedLine - 1,
        needle.generatedColumn,
        bias,
      );
    });

    if (mapping) {
      if (mapping.generatedLine === needle.generatedLine) {
        let source = mapping.source || null;
        if (source !== null) {
          source = this._absoluteSources.at(source);
        }

        let name = mapping.name || null;
        if (name !== null) {
          name = this._names.at(name);
        }

        return {
          source,
          line: mapping.originalLine,
          column: mapping.originalColumn,
          name,
        };
      }
    }

    return null;
  }
}

class IndexedSourceMapConsumer {
  constructor(sourceMap, sourceMapURL) {
    const { sections } = sourceMap;
    let lastOffset = {
      line: -1,
      column: 0,
    };
    this._sections = sections.map((s) => {
      if (s.url) {
        // The url field will require support for asynchronicity.
        // See https://github.com/mozilla/source-map/issues/16
        throw new Error('Support for url field in sections not implemented.');
      }
      const { offset, line: offsetLine, column: offsetColumn } = s;
      if (offsetLine < lastOffset.line
          || (offsetLine === lastOffset.line && offsetColumn < lastOffset.column)) {
        throw new Error('Section offsets must be ordered and non-overlapping.');
      }
      lastOffset = offset;
      // eslint-disable-next-line no-use-before-define
      const consumer = new SourceMapConsumer(s.map, sourceMapURL);
      return {
        consumer,
        generatedOffset: {
          // The offset fields are 0-based, but we use 1-based indices when
          // encoding/decoding from VLQ.
          generatedLine: offsetLine + 1,
          generatedColumn: offsetColumn + 1,
        },
      };
    });
  }

  originalPositionFor(args) {
    const needle = {
      generatedLine: args.line,
      generatedColumn: args.column,
    };

    // Find the section containing the generated position we're trying to map
    // to an original position.
    const sectionIndex = binarySearch(needle, this._sections, (aNeedle, section) => {
      const cmp = aNeedle.generatedLine - section.generatedOffset.generatedLine;
      if (cmp) {
        return cmp;
      }
      return aNeedle.generatedColumn - section.generatedOffset.generatedColumn;
    });
    const section = this._sections[sectionIndex];

    if (!section) {
      return null;
    }

    return section.consumer.originalPositionFor({
      line: needle.generatedLine - section.generatedOffset.generatedLine - 1,
      column: needle.generatedColumn
        - (section.generatedOffset.generatedLine === needle.generatedLine
          ? section.generatedOffset.generatedColumn - 1 : 0),
      bias: args.bias,
    });
  }
}

function SourceMapConsumer(aSourceMap, sourceMapURL) {
  let sourceMap = aSourceMap;
  if (typeof sourceMap === 'string') {
    sourceMap = util.parseSourceMapInput(aSourceMap);
  }

  if (sourceMap.sections) {
    return new IndexedSourceMapConsumer(sourceMap, sourceMapURL);
  }
  return new BasicSourceMapConsumer(sourceMap, sourceMapURL);
}

module.exports = { SourceMapConsumer };
