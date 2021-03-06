/**
 * Implementation of UI components that can be inserted into dom(). See documentation for
 * createElem() and create().
 */
"use strict";

const { Disposable } = require('./dispose.js');
const _domImpl = require('./_domImpl.js');
const _domDispose = require('./_domDispose.js');

// Use the browser globals in a way that allows replacing them with mocks in tests.
const G = require('./browserGlobals.js').use('document');

/**
 * A UI component should extend this base class and implement `render()`. Compared to a simple
 * function returning DOM (a "functional" component), a "class" component makes it easier to
 * organize code into methods.
 *
 * In addition, a "class" component may be disposed to remove it from the DOM, although this is
 * uncommon since a UI component is normally owned by its containing DOM.
 */
class Component extends Disposable {
  /**
   * This is not intended to be called directly or overridden. Instead, implement render().
   */
  create(elem, ...args) {
    let content = this.render(...args);

    this._markerPre = G.document.createComment('A');
    this._markerPost = G.document.createComment('B');

    // If the containing DOM is disposed, it will dispose all of our DOM (included among children
    // of the containing DOM). Let it also dispose this Component when it gets to _markerPost.
    // Since _unmount() is unnecessary here, we skip its work by unseting _markerPre/_markerPost.
    _domDispose.onDisposeElem(this._markerPost, () => {
      this._markerPre = this._markerPost = null;
      this.dispose();
    });

    // When the component is disposed, unmount the DOM we created (i.e. dispose and remove).
    // Except that we skip this as unnecessary when the disposal is triggered by containing DOM.
    this.autoDisposeWith(this._unmount, this);

    // Insert the result of render() into the given parent element.
    _domImpl.update(elem, this._markerPre, content, this._markerPost);
  }

  /**
   * Components must extend this class and implement a `render()` method, which is called at
   * construction with constructor arguments, and should return DOM for the component.
   *
   * It is recommended that any constructor work is done in this method.
   *
   * render() may return any type of value that's accepted by dom() as an argument, including a
   * DOM element, a string, null, or an array. The returned DOM is automatically owned by the
   * component, so do not wrap it in `this.autoDispose()`.
   */
  render() {
    throw new Error("Not implemented");
  }

  /**
   * Detaches and disposes the DOM created and attached in _mount().
   */
  _unmount() {
    // Dispose the owned content, and remove it from the DOM.
    if (this._markerPre && this._markerPre.parentNode) {
      let next, elem = this._markerPre.parentNode;
      for (let n = this._markerPre.nextSibling; n && n !== this._markerPost; n = next) {
        next = n.nextSibling;
        _domDispose.dispose(n);
        elem.removeChild(n);
      }
      elem.removeChild(this._markerPre);
      elem.removeChild(this._markerPost);
    }
  }
}
exports.Component = Component;

/**
 * Construct and insert a UI component into the given DOM element. The component must extend
 * dom.Component(...), and must implement a `render(...)` method which should do any constructor
 * work and return DOM. DOM may be any type value accepted by dom() as an argument, including a
 * DOM element, string, null, or array. The returned DOM is automatically owned by the component.
 *
 * Logically, the parent `elem` owns the created component, and the component owns the DOM
 * returned by its render() method. If the parent is disposed, so is the component and its DOM. If
 * the component is somehow disposed directly, then its DOM is disposed and removed from `elem`.
 *
 * Note the correct usage:
 *
 *       dom('div', dom.create(Comp1), dom.create(Comp2, ...args))
 *
 * To understand why the syntax is such, consider a potential alterntive such as:
 *
 *       dom('div', _insert_(new Comp1()), _insert_(new Comp2(...args))
 *
 *    In both cases, the constructor for Comp1 runs before the constructor for Comp2. What happens
 *    when Comp2's constructor throws an exception? In the second case, nothing yet owns the
 *    created Comp1 component, and it will never get cleaned up. In the first correct case,
 *    dom('div') element gets ownership of it early enough and will dispose it.
 *
 * @param {Element} elem: The element to which to append the newly constructed component.
 * @param {Class} ComponentClass: The component class to instantiate. It must extend
 *    dom.Component(...) and implement the render() method.
 * @param {Objects} ...args: Arguments to the constructor which passes them to the render method.
 */
function createElem(elem, ComponentClass, ...args) {
  new ComponentClass(elem, ...args);
}
function create(ComponentClass, ...args) {
  return elem => new ComponentClass(elem, ...args);
}
exports.createElem = createElem;
exports.create = create;
