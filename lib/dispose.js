/**
 * dispose.js provides tools to objects that needs to dispose resources, such as destroy DOM, and
 * unsubscribe from events. The motivation with examples is presented here:
 *
 *    https://phab.getgrist.com/w/disposal/
 *
 * Disposable is a mixin class for components that need cleanup (e.g. maintain DOM, listen to
 * events, subscribe to anything). It provides a .dispose() method that should be called to
 * destroy the component, and .autoDispose() family of methods that the component should use to
 * take responsibility for other pieces that require cleanup.
 *
 * To define a disposable class:
 *    class Foo extends Disposable {
 *      create(...args) { ...constructor work... }      // Instead of constructor, if needed.
 *    }
 *
 * To define a disposable class that derives from Base:
 *    class Foo extends mixinDisposable(Base) {
 *      create(...args) { ...constructor work... }      // Instead of constructor, if needed.
 *    }
 *
 * To create Foo:
 *    let foo = new Foo(args...);
 *
 * Foo should do constructor work in its create() method (or rarely other methods), where it can
 * take ownership of other objects:
 *    this.bar = this.autoDispose(new Bar(...));
 * The argument will get disposed when `this` is disposed using its `dispose` method. Other kinds
 * of objects may be disposable this way (e.g. DOM nodes when using a library that registers a
 * disposer for them using Disposable.registerDisposer).
 *
 * Note that create() is automatically called at construction. Its advantage is that if it throws
 * an exception, any calls to .autoDispose() that happened before the exception are honored.
 *
 * For more customized disposal:
 *    this.baz = this.autoDisposeWithMethod('destroy', new Baz());
 *    this.elem = this.autoDisposeWith(ko.cleanNode, document.createElement(...));
 * When `this` is disposed, it will call this.baz.destroy(), and ko.cleanNode(this.elem).
 *
 * To call another method on disposal (e.g. to add custom disposal logic):
 *    this.autoDisposeCallback(this.myUnsubscribeAllMethod);
 * The method will be called with `this` as context, and no arguments.
 *
 * To wipe out this object on disposal (i.e. set all properties to null):
 *    this.wipeOnDispose();
 * See the documentation of that method for more info.
 *
 * To dispose Foo:
 *    foo.dispose();
 * Owned objects will be disposed in reverse order from which `autoDispose` were called.
 *
 * To release an owned object:
 *    this.disposeRelease(this.bar);
 *
 * To dispose an owned object early:
 *    this.disposeDiscard(this.bar);
 *
 * To determine if an object has already been disposed:
 *    foo.isDisposed()
 */

"use strict";

// The private property name to hold the disposal list.
const _disposalList = Symbol('_disposalList');
const _wipeOnDisposal = Symbol('_wipeOnDisposal');

/**
 * Private list of disposer mappers. This is mainly to decouple this library from e.g. DOM
 * libraries that may register a disposer for any DOM node.
 */
const _registeredDisposerMappers = [_defaultDisposerMapper];

// The mixin solution follows the approach here:
// https://github.com/justinfagnani/mixwith.js/blob/master/mixwith.js,
// http://justinfagnani.com/2015/12/21/real-mixins-with-javascript-classes/
const mixinDisposable = _cachingFunc(superClass => class extends superClass {

  /**
   * Constructor forwards arguments to  `this.create(...args)`, which is where subclasses should
   * do any constructor work. This ensures that if create() throws an exception, dispose() gets
   * called to clean up the partially-constructed object.
   */
  constructor(...args) {
    super(...args);
    this[_disposalList] = [];

    try {
      this.create(...args);
    } catch (e) {
      try {
        this.dispose();
      } catch(e) {
        console.error("Error disposing partially constructed %s:", this.constructor.name, e);
      }
      throw e;
    }
  }

  /**
   * Called during construction. Implement this in subclasses to do constructor work safely. If
   * this throws an exception, the partially-constructed object will get cleaned up -- i.e. any
   * calls to `this.autoDispose()` that happened before the exception will be honored.
   * Method create() is NOT intended to be called directly.
   */
  create() {}

  /**
   * The name of this class will be 'Disposable:<Super>'.
   */
  static get name() { return "Disposable:" + super.name; }

  /**
   * Take ownership of `obj`, and dispose it when `this.dispose` is called.
   * @param {Object} obj: Disposable object to take ownership of.
   * @returns {Object} obj
   */
  autoDispose(obj) {
    return this.autoDisposeWith(_getDisposer(obj), obj);
  }

  /**
   * Take ownership of `obj`, and dispose it by calling the specified function.
   * @param {Function} disposer: disposer(obj) will be called to dispose the object, with `this`
   *    as the context.
   * @param {Object} obj: Object to take ownership of, on which `disposer` will be called.
   * @returns {Object} obj
   */
  autoDisposeWith(disposerFunc, obj) {
    this[_disposalList].push({obj: obj, disposer: disposerFunc});
    return obj;
  }

  /**
   * Take ownership of `obj`, and dispose it with `obj[methodName]()`.
   * @param {String} methodName: method name to call on obj when it's time to dispose it.
   * @returns {Object} obj
   */
  autoDisposeWithMethod(methodName, obj) {
    return this.autoDisposeWith(obj => obj[methodName](), obj);
  }

  /**
   * Adds the given callback to be called when `this.dispose` is called.
   * @param {Function} callback: Called on disposal with `this` as the context and no arguments.
   * @returns nothing
   */
  autoDisposeCallback(callback) {
    this.autoDisposeWith(_callFuncHelper, callback);
  }

  /**
   * Wipe out this object when it is disposed, i.e. set all its properties to null. It is
   * recommended to call this early in the constructor. It's safe to call multiple times.
   *
   * This makes disposal more costly, but has certain benefits:
   * - If anything still refers to the object and uses it, we'll get an early error, rather than
   *   silently keep going, potentially doing useless work (or worse) and wasting resources.
   * - If anything still refers to the object (even without using it), the fields of the object
   *   can still be garbage-collected.
   * - If there are circular references involving this object, they get broken, making the job
   *   easier for the garbage collector.
   *
   * The recommendation is to use it for complex, longer-lived objects, but to skip for objects
   * which are numerous and short-lived (and less likely to be referenced from unexpected places).
   */
  wipeOnDispose() {
    this[_wipeOnDisposal] = true;
  }

  /**
   * Remove `obj` from the list of owned objects; it will not be disposed on `this.dispose`.
   * @param {Object} obj: Object to release.
   * @returns {Object} obj
   */
  disposeRelease(obj) {
    let list = this[_disposalList];
    let index = list.findIndex(entry => (entry.obj === obj));
    if (index !== -1) {
      list.splice(index, 1);
    }
    return obj;
  }

  /**
   * Dispose an owned object `obj` now, and remove it from the list of owned objects.
   * @param {Object} obj: Object to release.
   * @returns nothing
   */
  disposeDiscard(obj) {
    let list = this[_disposalList];
    let index = list.findIndex(entry => (entry.obj === obj));
    if (index !== -1) {
      let entry = list[index];
      list.splice(index, 1);
      entry.disposer.call(this, obj);
    }
  }

  /**
   * Returns whether this object has already been disposed.
   */
  isDisposed() {
    return this[_disposalList] === null;
  }

  /**
   * Clean up `this` by disposing all owned objects, and calling `stopListening()` if defined.
   */
  dispose() {
    if (!this.isDisposed()) {
      let list = this[_disposalList];
      this[_disposalList] = null;         // This makes isDisposed() true.

      // Go backwards through the disposal list, and dispose everything.
      for (let i = list.length - 1; i >= 0; i--) {
        let entry = list[i];
        _disposeHelper(this, entry.disposer, entry.obj);
      }

      // If requested, finish by wiping out the object, to trigger early errors of anything
      // continues to use it, and to aid garbage collection.
      // See https://phab.getgrist.com/w/disposal/ for more motivation.
      if (this[_wipeOnDisposal]) {
        _wipeOutObject(this);
      }
    }
  }
});

const Disposable = mixinDisposable(Object);


/**
 * For use by certain libraries only.
 * To decide how to dispose an object created with `this.autoDispose(obj)`, we test it with
 * disposer mappers. By default, there is just one mapper, which tests if an object has .dispose
 * method, and calls that on disposal. Libraries can add more mappers, e.g. to set a disposer
 * function for any DOM element. The mappers gets scanned for every `autoDipose` call, so only
 * very commonly used mappers should be added. Anything custom should just use autoDisposeWith.
 * @param {Function} objToDisposerMapper: objToDisposerMapper(obj) can return a disposer
 *    function (function of one parameter) or null if this mapper doesn't handle this object.
 */
function registerDisposer(objToDisposerMapper) {
  _registeredDisposerMappers.push(objToDisposerMapper);
}


/**
 * Helper that wraps any function of a single argument, returning a version which caches the
 * return value of the function. For the cache, it uses a WeakMap with the argument as the key.
 */
function _cachingFunc(func) {
  let cache = new WeakMap();
  return arg => {
    if (!cache.has(arg)) {
      cache.set(arg, func(arg));
    }
    return cache.get(arg);
  };
}


/**
 * Internal helper to allow adding cleanup callbacks to the disposalList. It acts as the
 * "disposer" for callback, by simply calling them with the same context that it is called with.
 */
function _callFuncHelper(callback) {
  /* jshint validthis:true */
  callback.call(this);
}


/**
 * Wipe out the given object by setting each property to a dummy sentinel value. This is helpful
 * for objects that are disposed and should be ready to be garbage-collected.
 *
 * The sentinel value doesn't have to be null, but some values cause more helpful errors than
 * others. E.g. if a.x = "disposed", then a.x.foo() throws "undefined is not a function", while
 * when a.x = null, a.x.foo() throws "Cannot read property 'foo' of null", which is more helpful.
 */
function _wipeOutObject(obj) {
  Object.keys(obj).forEach(k => (obj[k] = null));
}


/**
 * Internal helper to call a disposer on an object. It swallows errors (but reports them) to make
 * sure that when we dispose an object, an error in disposing one owned part doesn't stop
 * the disposal of the other parts.
 */
function _disposeHelper(owner, disposer, obj) {
  try {
    disposer.call(owner, obj);
  } catch (e) {
    console.error("While disposing %s, error disposing %s: %s",
      _describe(owner), _describe(obj), e);
  }
}

/**
 * Helper for reporting errors during disposal. Try to report the type of the object.
 */
function _describe(obj) {
  return (obj && obj.constructor && obj.constructor.name ? obj.constructor.name : '' + obj);
}

/**
 * Helper disposer that simply invokes the .dispose() method.
 */
function _defaultDisposer(obj) {
  obj.dispose();
}

/**
 * To decide how to dispose an object created with `this.autoDispose(obj)`, we test it with
 * disposer mappers. This is the default one that always gets tested first: if the object has a
 * .dispose method, that's what will be used for disposal.
 */
function _defaultDisposerMapper(obj) {
  if (typeof obj.dispose === 'function') {
    return _defaultDisposer;
  }
}

/**
 * Find a suitable disposer for the object.
 */
function _getDisposer(obj) {
  for (let func of _registeredDisposerMappers) {
    let disposer = func(obj);
    if (disposer) {
      return disposer;
    }
  }
  throw new Error('Object is not disposable');
}

exports.Disposable = Disposable;
exports.mixinDisposable = mixinDisposable;
exports.registerDisposer = registerDisposer;
