import Delta from 'rich-text/lib/delta';
import Emitter from '../core/emitter';
import Module from '../core/module';
import Parchment from 'parchment';
import logger from '../core/logger';

let debug = logger('quill:clipboard');


const DOM_KEY = '__ql-matcher';
const BLOCK_ELEMENTS = {
  'ADDRESS': true,
  'ARTICLE': true,
  'ASIDE': true,
  'BLOCKQUOTE': true,
  'CANVAS': true,
  'DIV': true,
  'DL': true,
  'FIELDSET': true,
  'FIGCAPTION': true,
  'FIGURE': true,
  'FOOTER': true,
  'FORM': true,
  'HEADER': true,
  'H1': true, 'H2': true, 'H3': true, 'H4': true, 'H5': true, 'H6': true,
  'HGROUP': true,
  'HR': true,
  'LI': true,
  'MAIN': true,
  'NAV': true,
  'NOSCRIPT': true,
  'OL': true,
  'OUTPUT': true,
  'P': true,
  'PRE': true,
  'SECTION': true,
  'TABLE': true,
  'TFOOT': true,
  'UL': true,
  'VIDEO': true
};


class Clipboard extends Module {
  constructor(quill, options) {
    super(quill, options);
    this.onCopy = this.onCopy.bind(this);
    this.onCut = this.onCut.bind(this);
    this.onPaste = this.onPaste.bind(this);
    this.bind();
    this.container = this.quill.addContainer('ql-clipboard');
    this.container.setAttribute('contenteditable', true);
    this.matchers = [
      [Node.TEXT_NODE, matchText],
      [Node.ELEMENT_NODE, matchNewline],
      [Node.ELEMENT_NODE, matchBlot],
      [Node.ELEMENT_NODE, matchSpacing],
      ['b, i', matchAliases]
    ];
  }

  bind() {
    this.quill.root.addEventListener('copy', this.onCopy);
    this.quill.root.addEventListener('cut', this.onCut);
    this.quill.root.addEventListener('paste', this.onPaste);
  }

  unbind() {
    this.quill.root.removeEventListener('copy', this.onCopy);
    this.quill.root.removeEventListener('cut', this.onCut);
    this.quill.root.removeEventListener('paste', this.onPaste);
  }

  destroy() {
    this.unbind();
  }

  addMatcher(selector, matcher) {
    this.matchers.push([selector, matcher]);
  }

  convert(container) {
    this.matchers.forEach((pair) => {
      let [selector, matcher] = pair;
      if (typeof selector === 'string') {
        [].forEach.call(container.querySelectorAll(selector), (node) => {
          // TODO use weakmap
          node[DOM_KEY] = node[DOM_KEY] || [];
          node[DOM_KEY].push(matcher);
        });
      }
    });
    let traverse = (node) => {  // Post-order
      return [].reduce.call(node.childNodes || [], (delta, childNode) => {
        let childrenDelta = traverse(childNode);
        childrenDelta = this.matchers.reduce(function(childrenDelta, pair) {
          let [type, matcher] = pair;
          if (type === true || childNode.nodeType === type) {
            childrenDelta = matcher(childNode, childrenDelta);
          }
          return childrenDelta;
        }, childrenDelta);
        childrenDelta = (childNode[DOM_KEY] || []).reduce(function(childrenDelta, matcher) {
          return matcher(childNode, childrenDelta);
        }, childrenDelta);
        return delta.concat(childrenDelta);
      }, new Delta());
    };
    return traverse(container);
  }

  onCopy(e) {
    let range = this.quill.getSelection();
    if (range == null || range.length === 0 || e.defaultPrevented) return;
    let clipboard = e.clipboardData || window.clipboardData;
    clipboard.setData('text', this.quill.getText(range));
    if (e.clipboardData) {  // IE11 does not let us set non-text data
      clipboard.setData('application/json', JSON.stringify(this.quill.getContents(range)));
    }
    e.preventDefault();
  }

  onCut(e) {
    if (e.defaultPrevented) return;
    this.onCopy(e);
    let range = this.quill.getSelection();
    this.quill.deleteText(range, Emitter.sources.USER);
    this.quill.setSelection(range.index, Emitter.sources.SILENT);
  }

  onPaste(e) {
    if (e.defaultPrevented) return;
    let range = this.quill.getSelection();
    let clipboard = e.clipboardData || window.clipboardData;
    let delta = new Delta().retain(range.index).delete(range.length);
    let callback = (delta) => {
      this.quill.updateContents(delta, Emitter.sources.USER);
      // range.length contributes to delta.length()
      this.quill.setSelection(delta.length() - range.length*2, Emitter.sources.SILENT);
      this.quill.selection.scrollIntoView();
    };
    let intercept = (delta) => {
      this.container.focus();
      setTimeout(() => {
        delta = delta.concat(this.convert(this.container));
        debug.info('paste', this.container.innerHTML, delta);
        this.container.innerHTML = '';
        callback(delta);
      }, 1);
    };
    // Firefox types is an iterable, not array
    // IE11 types can be null
    if ([].indexOf.call(clipboard.types || [], 'application/json') > -1) {
      try {
        let pasteJSON = JSON.parse(clipboard.getData('application/json'));
        callback(delta.concat(pasteJSON));
      } catch(err) {
        intercept(delta);
      }
      e.preventDefault();
      return;
    }
    intercept(delta);
  }
}


function deltaEndsWith(delta, text) {
  let lastOp = delta.ops[delta.ops.length - 1];
  // TODO fix case where delta lastOp length < text.length
  let endText = (lastOp == null || typeof lastOp.insert !== 'string') ? '' : lastOp.insert;
  return endText.slice(-1*text.length) === text;
}

function matchAliases(node, delta) {
  let formats = {};
  switch(node.tagName) {
    case 'B':
      formats = { bold: true };
      break;
    case 'I':
      formats = { italic: true };
      break;
    default: return delta;
  }
  return delta.compose(new Delta().retain(delta.length(), formats));
}

function matchBlot(node, delta) {
  let match = Parchment.query(node);
  if (match == null) return delta;
  if (match.prototype instanceof Parchment.Embed) {
    let embed = {};
    embed[match.blotName] = match.value(node);
    delta.insert(embed, match.formats(node));
  } else if (typeof match.formats === 'function') {
    delta = delta.compose(new Delta().retain(delta.length(), match.formats(node)));
  }
  return delta;
}

function matchNewline(node, delta) {
  if (BLOCK_ELEMENTS[node.tagName] || node.style.display === 'block') {
    if (!deltaEndsWith(delta, '\n')) {
      delta.insert('\n');
    }
  }
  return delta;
}

function matchSpacing(node, delta) {
  if (node.style.paddingBottom || (node.style.marginBottom && !deltaEndsWith(delta, '\n\n'))) {
    delta.insert('\n');
  }
  return delta;
}

function matchText(node, delta) {
  let text = node.data.replace(/\s\s+/g, ' ');
  return delta.insert(text);
}


export default Clipboard;
