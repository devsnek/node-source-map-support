'use strict';

// https://github.com/evanw/node-source-map-support/blob/master/source-map-support.js

const { readFileSync } = require('fs');
const { fileURLToPath } = require('url');
const path = require('path');
const { SourceMapConsumer } = require('./source_map');

function readFile(pathname) {
  if (pathname.startsWith('file:')) {
    pathname = fileURLToPath(pathname);
  }
  return readFileSync(pathname, 'utf8');
}

const cache = new Map();

function supportRelativeURL(file, url) {
  if (!file) {
    return url;
  }
  const dir = path.dirname(file);
  const match = /^\w+:\/\/[^/]*/.exec(dir);
  let protocol = match ? match[0] : '';
  const startPath = dir.slice(protocol.length);
  if (protocol && /^\/\w:/.test(startPath)) {
    // handle file:///C:/ paths
    protocol += '/';
    return protocol + path.resolve(dir.slice(protocol.length), url).replace(/\\/g, '/');
  }
  return protocol + path.resolve(dir.slice(protocol.length), url);
}

function getSourceMap(pathname, source) {
  if (cache.has(pathname)) {
    return cache.get(pathname);
  }

  try {
    if (!source) {
      source = readFile(pathname);
    }
    const re = /(?:\/\/[@#][ \t]+sourceMappingURL=([^\s'"]+?)[ \t]*$)|(?:\/\*[@#][ \t]+sourceMappingURL=([^*]+?)[ \t]*(?:\*\/)[ \t]*$)/mg;
    let lastMatch;
    while (true) { // eslint-disable-line no-constant-condition
      const match = re.exec(source);
      if (!match) {
        break;
      }
      lastMatch = match;
    }
    if (!lastMatch) {
      cache.set(pathname, null);
      return null;
    }
    const r = supportRelativeURL(pathname, lastMatch[1]);
    const sourceMap = new SourceMapConsumer(readFile(r), r);
    cache.set(pathname, sourceMap);

    if (sourceMap.sourcesContent) {
      sourceMap.sources.forEach((s, i) => {
        const contents = sourceMap.sourcesContent[i];
        if (contents) {
          const url = supportRelativeURL(sourceMap.url, s);
          getSourceMap(url, contents);
        }
      });
    }

    return sourceMap;
  } catch {
    cache.set(pathname, null);
    return null;
  }
}

function getSourceMapPosition(position) {
  const sourceMap = getSourceMap(position.source);
  if (sourceMap) {
    const originalPosition = sourceMap.originalPositionFor(position);
    if (originalPosition !== null) {
      return originalPosition;
    }
  }
  return position;
}

function getEvalOrigin(frame) {
  const origin = frame.getEvalOrigin();
  if (origin) {
    let match = /^eval at ([^(]+) \((.+):(\d+):(\d+)\)$/.exec(origin);
    if (match) {
      const position = getSourceMapPosition({
        source: match[2],
        line: Number.parseInt(match[3], 10),
        column: Number.parseInt(match[4], 10) - 1,
      });
      return `eval at ${match[1]} (${position.source}:${position.line}:${position.column + 1})`;
    }
    match = /^eval at ([^(]+) \((.+)\)$/.exec(origin);
    if (match) {
      return `eval at ${match[1]} (${getEvalOrigin(match[2])})`;
    }
  }
  return null;
}

function frameToString(frame, position, evalOrigin) {
  // JSStackFrame::ToString
  const isTopLevel = frame.isToplevel();
  const isAsync = frame.isAsync && frame.isAsync();
  const isPromiseAll = frame.isPromiseAll && frame.isPromiseAll();
  const isConstructor = frame.isConstructor();
  const isMethodCall = !(isTopLevel || isConstructor);
  const functionName = (position && position.name) || frame.getFunctionName();

  // AppendFileLocation
  const locationInfo = () => {
    const fileName = position ? position.source : null;
    let out = '';
    if (!fileName && frame.isEval()) {
      out += `${evalOrigin}, `;
    }
    if (fileName) {
      out += fileName;
    } else {
      out += '<anonymous>';
    }
    const lineNumber = position ? position.line : frame.getLineNumber();
    if (lineNumber !== -1) {
      out += `:${lineNumber}`;
      const columnNumber = position ? position.column : frame.getColumnNumber();
      if (columnNumber !== -1) {
        out += `:${columnNumber}`;
      }
    }
    return out;
  };

  let string = isAsync ? 'async ' : '';
  if (isPromiseAll) {
    string += `Promise.all (index ${frame.getPromiseIndex()})`;
    return string;
  }
  if (isMethodCall) {
    // AppendMethodCall
    const typeName = frame.getTypeName();
    const methodName = frame.getMethodName();
    if (functionName) {
      if (typeName) {
        const startsWithTypeName = functionName.startsWith(typeName);
        if (!startsWithTypeName) {
          string += `${typeName}.`;
        }
      }
      string += functionName;
      if (methodName) {
        // StringEndsWithMethodName(functionName, methodName);
        if (functionName !== methodName && !functionName.endsWith(`.${methodName}`)) {
          string += ` [as ${methodName}]`;
        }
      }
    } else {
      if (typeName) {
        string += `${typeName}.`;
      }
      if (methodName) {
        string += methodName;
      } else {
        string += '<anonymous>';
      }
    }
  } else if (isConstructor) {
    string += 'new ';
    if (functionName) {
      string += functionName;
    } else {
      string += '<anonymous>';
    }
  } else if (functionName) {
    string += functionName;
  } else {
    return `${string}${locationInfo()}`;
  }

  return `${string} (${locationInfo()})`;
}

function getMappedString(frame) {
  if (frame.isNative()) {
    return frame.toString();
  }

  const source = frame.getFileName() || frame.getScriptNameOrSourceURL();
  if (source) {
    const position = getSourceMapPosition({
      source,
      line: frame.getLineNumber(),
      column: frame.getColumnNumber() - 1,
    });
    if (position) {
      return frameToString(frame, position, null);
    }
  }

  if (frame.isEval()) {
    const evalOrigin = getEvalOrigin(frame);
    if (evalOrigin !== null) {
      return frameToString(frame, null, evalOrigin);
    }
  }

  return frame.toString();
}

module.exports = () => {
  const originalPrepareStackTrace = Error.prepareStackTrace;

  Error.prepareStackTrace = (error, stack) => {
    const errString = error instanceof Error ? `${error}` : `${error.name}: ${error.message}`;
    const frames = stack.map((frame) => `\n    at ${getMappedString(frame)}`);

    return `${errString}${frames.join('')}`;
  };

  return () => {
    if (originalPrepareStackTrace) {
      Error.prepareStackTrace = originalPrepareStackTrace;
    } else {
      delete Error.prepareStackTrace;
    }
  };
};
