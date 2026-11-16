# TS/JS Style Guide

## Introduction

### Terminology notes

This Style Guide uses RFC 2119 terminology when using the phrases must, must not, should, should not, and may. The terms prefer and avoid correspond to should and should not, respectively. Imperative and declarative statements are prescriptive and correspond to must.

### Guide notes

All examples given are non-normative and serve only to illustrate the normative language of the style guide. That is, while the examples are in Google Style, they may not illustrate the only stylish way to represent the code. Optional formatting choices made in examples must not be enforced as rules.


## VeriQ formatting rules

These rules are normative and override the Google wording where they differ.

- Indent blocks with 4 spaces. Never use a tab. Nested blocks add 4 spaces. A continuation may align with the opening delimiter, or use a hanging indent of 4 spaces from the start of the statement.
- Code lines are at most 120 characters, matching Prettier `printWidth` 120.
- Ordinary string literals use double quotes, matching Prettier `singleQuote: false`. See the string-literal section.
- Comments and JSDoc are written in Chinese. The first line of a comment block has at least 40 characters. Each comment line has at most 80 characters; wrap the rest.
- The product name VeriQ and technical identifiers may stay as written inside a Chinese comment.


## Source file basics

### File encoding: UTF-8

Source files are encoded in UTF-8.

#### Whitespace characters

Aside from the line terminator sequence, the ASCII horizontal space character (0x20) is the only whitespace character that appears anywhere in a source file. This implies that all other whitespace characters in string literals are escaped.

#### Special escape sequences

For any character that has a special escape sequence (`\'`, `\"`, `\\ `, `\b`, `\f`, `\n`, `\r`, `\t`, `\v`), that sequence is used rather than the corresponding numeric escape (e.g `\x0a`, `\u000a`, or `\u{a}`). Legacy octal escapes are never used.

#### Non-ASCII characters

For the remaining non-ASCII characters, use the actual Unicode character (e.g. `∞`). For non-printable characters, the equivalent hex or Unicode escapes (e.g. `\u221e`) can be used along with an explanatory comment.

```
// 直接写出微秒符号 μs，读者不用对照转义表，这种可打印字符不必再额外加注释，本例就是这样。
const units = "μs";

// 不可打印字符用转义写出来，并在旁边说明它是什么，避免文件里留下看不见的码位，本例就是这样。
const output = "\ufeff" + content;  // 这里的转义是字节顺序标记。不写明的话，读者只能看到一串十六进制，不知道该不该留。

```

```
// 反例把可打印的 μs 写成数字转义，即使旁边有注释，也比直接写字符更容易抄错码位。
const units = "\u03bcs";  // 反例试图用注释解释这是希腊字母 μ 加 s，直接写字符比写数字转义更不容易错，本例就是这样。

// 反例只留下转义，没有说明它代表字节顺序标记，读者无法判断这个前缀是否该保留，本例就是这样。
const output = "\ufeff" + content;

```

## Source file structure

Files consist of the following, in order:

1. Copyright information, if present
2. JSDoc with `@fileoverview` and/or other file-level JSDoc tags if present.
3. Imports, if present
4. The file’s implementation

Exactly one blank line separates each section that is present.

### Copyright information

If license or copyright information is necessary in a file, add it in a JSDoc at the top of the file.

### `@fileoverview` JSDoc

A file may have a top-level `@fileoverview` JSDoc. If present, it may provide a description of the file’s content, its uses, or information about its dependencies. Wrapped lines are not indented.

Example:

```
/**
 * 文件概览要写这个模块负责什么、谁会导入它，不要用占位的拉丁文把概览凑长，本例就是这样。
 *
 * 换行后的概览不要再缩进，保持和第一行说明同一列。
 */

```

### Imports

There are four variants of import statements in ES6 and TypeScript:

| Import type | Example | Use for |
| --- | --- | --- |
| module 1 | `import * as foo from '...';` | TypeScript imports |
| named 2 | `import {SomeThing} from '...';` | TypeScript imports |
| default | `import SomeThing from '...';` | Only for other external code that requires them |
| side-effect | `import '...';` | Only to import libraries for their side-effects on load (such as custom elements) |

```
// 正例在命名空间导入和具名导入之间按使用频率选择，而不是两种写法混在同一段依赖里。
import * as ng from "@angular/core";
import {Foo} from "./foo";

// 只有外部模块强制要求默认导入时才用默认导入，本仓库自己的模块一律用具名导出，本例就是这样。
import Button from "Button";

// 这些导入是为了加载时的副作用，例如注册自定义元素，不是为了使用它们导出的符号，本例就是这样。
import "jasmine";
import "@polymer/paper-button";

```

#### Import paths

TypeScript code must use paths to import other TypeScript code. Paths may be relative, i.e. starting with `.` or `..`, or rooted at the base directory, e.g. `root/path/to/file`.

Code should use relative imports (`./foo`) rather than absolute imports `path/to/foo` when referring to files within the same (logical) project as this allows to move the project around without introducing changes in these imports.

Consider limiting the number of parent steps (`../../../`) as those can make module and path structures hard to understand.

```
import {Symbol1} from "path/from/root";
import {Symbol2} from "../parent/file";
import {Symbol3} from "./sibling";

```

#### Namespace versus named imports

Both namespace and named imports can be used.

Prefer named imports for symbols used frequently in a file or for symbols that have clear names, for example Jasmine’s `describe` and `it`. Named imports can be aliased to clearer names as needed with `as`.

Prefer namespace imports when using many different symbols from large APIs. A namespace import, despite using the `*` character, is not comparable to a “wildcard” import as seen in other languages. Instead, namespace imports give a name to all the exports of a module, and each exported symbol from the module becomes a property on the module name. Namespace imports can aid readability for exported symbols that have common names like `Model` or `Controller` without the need to declare aliases.

```
// 反例把同一模块的符号逐个改名，导入行被别名撑得很长，模块名本身就可以充当命名空间。
import {Item as TableviewItem, Header as TableviewHeader, Row as TableviewRow,
    Model as TableviewModel, Renderer as TableviewRenderer} from "./tableview";

let item: TableviewItem|undefined;

```

```
// 正例导入整个模块，再用模块名访问 Item，避免在导入行里排列一长串别名，本例就是这样。
import * as tableview from "./tableview";

let item: tableview.Item|undefined;

```

```
import * as testing from "./testing";

// 反例让 testing.describe 这种常见测试函数也带上模块前缀，前缀没有提供额外信息。
testing.describe("foo", () => {
    testing.it("bar", () => {
        testing.expect(null).toBeNull();
        testing.expect(undefined).toBeUndefined();
    });
});

```

```
// 正例直接具名导入 describe、it 和 expect，调用点不再重复模块名。
import {describe, it, expect} from "./testing";

describe("foo", () => {
    it("bar", () => {
        expect(null).toBeNull();
        expect(undefined).toBeUndefined();
    });
});

```

##### Special case: Apps JSPB protos

Apps JSPB protos must use named imports, even when it leads to long import lines.

This rule exists to aid in build performance and dead code elimination since often `.proto` files contain many `message` s that are not all needed together. By leveraging destructured imports the build system can create finer grained dependencies on Apps JSPB messages while preserving the ergonomics of path based imports.

```
// 从 proto 文件只导入这次用到的消息，构建才能按消息裁剪，而不是把整份 proto 拉进来。
import {Foo, Bar} from "./foo.proto";

function copyFooBar(foo: Foo, bar: Bar) {...}

```

#### Renaming imports

Code should fix name collisions by using a namespace import or renaming the exports themselves. Code may rename imports (`import {SomeThing as SomeOtherThing}`) if needed.

Three examples where renaming can be helpful:

1. If it’s necessary to avoid collisions with other imported symbols.
2. If the imported symbol name is generated.
3. If importing symbols whose names are unclear by themselves, renaming can improve code clarity. For example, when using RxJS the `from` function might be more readable when renamed to `observableFrom`.

### Exports

Use named exports in all code:

```
// 模块使用具名导出，导入方必须写出同一个名字，重命名不会悄悄指向另一份实现，本例就是这样。
export class Foo { ... }

```

Do not use default exports. This ensures that all imports follow a uniform pattern.

```
// 不要使用默认导出。默认导出名由导入方随意起，重构时无法靠名字找到全部调用点，本例就是这样。
// 这是被禁止的默认导出。导入方可以把它叫成任何名字，模块自己的名字因此丢失，本例就是这样。
export default class Foo { ... }

```

Why?

Default exports provide no canonical name, which makes central maintenance difficult with relatively little benefit to code owners, including potentially decreased readability:

```
import Foo from "./bar";  // 默认导出允许导入方自选本地名，两个不同的名字可以指向同一个模块里的同一个类，本例就是这样。
import Bar from "./bar";  // 另一个导入方把同一默认导出叫成别的名字，阅读调用点时无法知道它们是同一个类，本例就是这样。

```

Named exports have the benefit of erroring when import statements try to import something that hasn’t been declared. In `foo.ts`:

```
const foo = "blah";
export default foo;

```

And in `bar.ts`:

```
import {fizz} from "./foo";

```

Results in `error TS2614: Module '"./foo"' has no exported member 'fizz'.` While `bar.ts`:

```
import fizz from "./foo";

```

Results in `fizz === foo`, which is probably unexpected and difficult to debug.

Additionally, default exports encourage people to put everything into one big object to namespace it all together:

```
export default class Foo {
    static SOME_CONSTANT = ...
    static someHelpfulFunction() { ... }
    ...
}

```

With the above pattern, we have file scope, which can be used as a namespace. We also have a perhaps needless second scope (the class `Foo`) that can be ambiguously used as both a type and a value in other files.

Instead, prefer use of file scope for namespacing, as well as named exports:

```
export const SOME_CONSTANT = ...
export function someHelpfulFunction()
export class Foo {
    // 这个类体只放属于类的成员，文件里的其他函数不要塞进类里，免得实例上出现无用字段。
}

```

#### Export visibility

TypeScript does not support restricting the visibility for exported symbols. Only export symbols that are used outside of the module. Generally minimize the exported API surface of modules.

#### Mutable exports

Regardless of technical support, mutable exports can create hard to understand and debug code, in particular with re-exports across multiple modules. One way to paraphrase this style point is that `export let` is not allowed.

```
export let foo = 3;
// 纯 ES6 里导入方能看到 foo 在一秒后变成 4。若另一个文件再导出它，TypeScript 的导入方看不到这次修改。
window.setTimeout(() => {
    foo = 4;
// 延时的单位是毫秒。只写 1000 时，读者无法判断 setTimeout 的第二个参数是秒还是毫秒。
}, 1000);

```

If one needs to support externally accessible and mutable bindings, they should instead use explicit getter functions.

```
let foo = 3;
window.setTimeout(() => {
    foo = 4;
// 延时的单位是毫秒。只写 1000 时，读者无法判断 setTimeout 的第二个参数是秒还是毫秒。
}, 1000);
// 可变状态留在模块内部，对外只提供读取函数，导入方就不会依赖一个随后会变的绑定，本例就是这样。
export function getFoo() { return foo; };

```

For the common pattern of conditionally exporting either of two values, first do the conditional check, then the export. Make sure that all exports are final after the module’s body has executed.

```
function pickApi() {
    if (useOtherApi()) return OtherApi;
    return RegularApi;
}
export const SomeApi = pickApi();

```

#### Container classes

Do not create container classes with static methods or properties for the sake of namespacing.

```
export class Container {
    static FOO = 1;
    static bar() { return 1; }
}

```

Instead, export individual constants and functions:

```
export const FOO = 1;
export function bar() { return 1; }

```

### Import and export type

#### Import type

You may use `import type {...}` when you use the imported symbol only as a type. Use regular imports for values:

```
import type {Foo} from "./foo";
import {Bar} from "./foo";

import {type Foo, Bar} from "./foo";

```

The TypeScript compiler automatically handles the distinction and does not insert runtime loads for type references. So why annotate type imports?

The TypeScript compiler can run in 2 modes:

- In development mode, we typically want quick iteration loops. The compiler transpiles to JavaScript without full type information. This is much faster, but requires `import type` in certain cases.
- In production mode, we want correctness. The compiler type checks everything and ensures `import type` is used correctly.

Note: If you need to force a runtime load for side effects, use `import '...';`. See the imports.

#### Export type

Use `export type` when re-exporting a type, e.g.:

```
export type {AnInterface} from "./foo";

```

`export type` is useful to allow type re-exports in file-by-file transpilation. See `isolatedModules` docs.

`export type` might also seem useful to avoid ever exporting a value symbol for an API. However it does not give guarantees, either: downstream code might still import an API through a different path. A better way to split & guarantee type vs value usages of an API is to actually split the symbols into e.g. `UserService` and `AjaxUserService`. This is less error prone and also better communicates intent.

#### Dynamic `import()` type

Do not use the `import()` function inside type annotations.

```
let f: import("./foo").Foo;

```

If you need to ensure that the import is always elided from the generated JavaScript, use `import type` instead.

```
import type {Foo} from "./foo";

```

#### Use modules not namespaces

TypeScript supports two methods to organize code: namespaces and modules, but namespaces are disallowed. That is, your code must refer to code in other files using imports and exports of the form `import {foo} from 'bar';`

Your code must not use the `namespace Foo { ... }` construct. `namespace` s may only be used when required to interface with external, third party code. To semantically namespace your code, use separate files.

Code must not use `require` (as in `import x = require('...');`) for imports. Use ES6 module syntax.

```
// 不要再用 namespace 声明。它不是 ES 模块，导入关系和树摇都比模块导入更差。
namespace Rocket {
    function launch() { ... }
}

// 不要用三斜线 reference 把另一个文件拉进来，依赖应写在 import 里，而不是编译器的旧式包含指令。
/// <reference path="..."/>

// 不要用 import 赋值调用 require。运行时加载应使用动态 import，类型和打包器都认不出 require。
import x = require("mydep");

```

> NB: TypeScript `namespace` s used to be called internal modules and used to use the `module` keyword in the form `module Foo { ... }`. Don’t use that either. Always use ES6 imports.

## Language features

This section delineates which features may or may not be used, and any additional constraints on their use.

Language features which are not discussed in this style guide may be used with no recommendations of their usage.

### Local variable declarations

#### Use const and let

Always use `const` or `let` to declare variables. Use `const` by default, unless a variable needs to be reassigned. Never use `var`.

```
const foo = otherValue;  // foo 在初始化之后不再赋值，所以用 const，读者可以把它当成这份模块里的稳定绑定。
let bar = someValue;  // bar 后面还会被重新赋值，必须用 let，不能为了省事写成初始化之后不能再改的 const。

```

`const` and `let` are block scoped, like variables in most other languages. `var` in JavaScript is function scoped, which can cause difficult to understand bugs. Don’t use it.

```
var foo = someValue;  // 不要用 var。它是函数作用域，会在块外仍然可见，这种提升经常引入难以定位的赋值错误。

```

Variables must not be used before their declaration.

#### One variable per declaration

Every local variable declaration declares only one variable: declarations such as `let a = 1, b = 2;` are not used.

### Array literals

#### Do not use the `Array` constructor

Do not use the `Array()` constructor, with or without `new`. It has confusing and contradictory usage:

```
const a = new Array(2);  // 用数组构造函数只传入长度时，得到的是空槽，不是两个已经放好的元素，遍历结果会不同。
const b = new Array(2, 3);  // 传入两个数字时，数组构造函数把它们当成元素，而不是按其中一个数字预分配长度，本例就是这样。

```

Instead, always use bracket notation to initialize arrays, or `from` to initialize an `Array` with a certain size:

```
const a = [2];
const b = [2, 3];

// 先建空数组再改 length，效果和只传长度的构造函数一样，数组里留下的仍是空槽。
const c = [];
c.length = 2;

// 需要固定长度的零填充数组时，用 Array.from 再 fill，不要依赖构造函数的长度参数。
Array.from<number>({length: 5}).fill(0);

```

#### Do not define properties on arrays

Do not define or use non-numeric properties on an array (other than `length`). Use a `Map` (or `Object`) instead.

#### Array destructuring

Array literals may be used on the left-hand side of an assignment to perform destructuring (such as when unpacking multiple values from a single array or iterable). A final “rest” element may be included (with no space between the `...` and the variable name). Elements should be omitted if they are unused.

```
const [a, b, c, ...rest] = generateResults();
let [, b,, d] = someArray;

```

Destructuring may also be used for function parameters. Always specify `[]` as the default value if a destructured array parameter is optional, and provide default values on the left hand side:

```
function destructured([a = 4, b = 2] = []) { … }

```

Disallowed:

```
function badDestructuring([a, b] = [4, 2]) { … }

```

Tip: For (un)packing multiple values into a function’s parameter or return, prefer object destructuring to array destructuring when possible, as it allows naming the individual elements and specifying a different type for each.

### Object literals

#### Do not use the `Object` constructor

The `Object` constructor is disallowed. Use an object literal (`{}` or `{a: 0, b: 1, c: 2}`) instead.

#### Iterating objects

Iterating objects with `for (... in ...)` is error prone. It will include enumerable properties from the prototype chain.

Do not use unfiltered `for (... in ...)` statements:

```
for (const x in someObj) {
    // for-in 会走到原型链上的可枚举属性，循环变量不一定是这个对象自己定义的键。
}

```

Either filter values explicitly with an `if` statement, or use `for (... of Object.keys(...))`.

```
for (const x in someObj) {
    if (!someObj.hasOwnProperty(x)) continue;
    // 过滤掉原型链上的键之后，循环变量才确定是 someObj 自己的属性，而不是继承来的名字。
}
// 这里是 for-of，不是 for-in，遍历的是键的列表而不是对象的枚举协议。
for (const x of Object.keys(someObj)) {
    // 过滤掉原型链上的键之后，循环变量才确定是 someObj 自己的属性，而不是继承来的名字。
}
// 这里是 for-of，不是 for-in，遍历的是键的列表而不是对象的枚举协议。
for (const [key, value] of Object.entries(someObj)) {
    // Object.entries 只给出对象自己的键值对，这里的 key 不会来自原型链上的可枚举属性。
}

```

#### Using spread syntax

Using spread syntax `{...bar}` is a convenient shorthand for creating a shallow copy of an object. When using spread syntax in object initialization, later values replace earlier values at the same key.

```
const foo = {
    num: 1,
};

const foo2 = {
    ...foo,
    num: 5,
};

const foo3 = {
    num: 5,
    ...foo,
}

foo2.num === 5;
foo3.num === 1;

```

Avoid spreading objects that have prototypes other than the Object prototype (e.g. class definitions, class instances, functions) as the behavior is unintuitive (only enumerable non-prototype properties are shallow-copied).

```
// 把数组展开进对象会得到下标键，结果没有 length，之后不能再把它当成数组来用。
const fooStrings = ["a", "b", "c"];
const ids = {...fooStrings};

```

```
const options = {foo: 1, bar: 2};
const extended = {...options, baz: 3};

```

#### Computed property names

Computed property names (e.g. `{['key' + foo()]: 42}`) are allowed, and are considered dict-style (quoted) keys (i.e., must not be mixed with non-quoted keys) unless the computed property is a symbol (e.g. `[Symbol.iterator]`).

#### Object destructuring

Object destructuring patterns may be used on the left-hand side of an assignment to perform destructuring and unpack multiple values from a single object.

Destructured objects may also be used as function parameters, but should be kept as simple as possible: a single level of unquoted shorthand properties. Deeper levels of nesting and computed properties may not be used in parameter destructuring. Specify any default values in the left-hand-side of the destructured parameter (`{str = 'some default'} = {}`, rather than `{str} = {str: 'some default'}`), and if a destructured object is itself optional, it must default to `{}`.

Example:

```
interface Options {
    /** 这个可选数字表示同一操作要重复的次数，不传时由调用方的默认逻辑决定重复几次，本例就是这样。 */
    num?: number;

    /** 这个可选字符串是被处理的文本，缺省时使用参数初始化器里的默认文本，而不是空串，本例就是这样。 */
    str?: string;
}

function destructured({num, str = "default"}: Options = {}) {}

```

Disallowed:

```
function nestedTooDeeply({x: {num, str}}: {x: Options}) {}
function nontrivialDefault({num, str}: Options = {num: 42, str: "default"}) {}

```

### Classes

#### Class declarations

Class declarations must not be terminated with semicolons:

```
class Foo {
}

```

```
class Foo {
};  // 类声明本身不是语句，末尾的分号是多余的，应删掉，以免看起来像紧跟着另一条语句，本例就是这样。

```

In contrast, statements that contain class expressions must be terminated with a semicolon:

```
export const Baz = class extends Bar {
    method(): number {
        return this.x;
    }
};  // 把类表达式赋给常量属于语句，末尾的分号必须保留，单独写出的类声明才不需要分号，本例就是这样。

```

```
exports const Baz = class extends Bar {
    method(): number {
        return this.x;
    }
}

```

It is neither encouraged nor discouraged to have blank lines separating class declaration braces from other class content:

```
// 类体大括号内侧不留空行是允许的，成员可以紧跟在括号后面，不必为了透气再插空行，本例就是这样。
class Baz {
    method(): number {
        return this.x;
    }
}

// 类体大括号内侧各留一个空行也可以，但不要在同一个类里混用有空行和没空行两种密度。
class Foo {

    method(): number {
        return this.x;
    }

}

```

#### Don’t create member variables only used in constructors

If a variable is only used in the constructor, then it can be migrated to be a variable scoped to the constructor body, which will make your class more stateless and easier to reason about for future devs.

Some classes have methods that are only called in the constructor and that update bits of class state that are only used during class construction. For the same reasons as above, these bits of class state should also be migrated to be constructor-local variables.

```
class MyClass {
    // 反例把只在构造函数里用到的值存成字段，构造结束之后这个字段再也不会被任何方法读取。
    private readonly onlyUsedInCtor = ...;
    private readonly otherDataStructure = ...;
    constructor(
        // 反例用参数属性把服务留在实例上，但这些服务在构造函数返回后就没有任何方法再使用。
        private readonly serviceA: ServiceA,
        private readonly serviceB: ServiceB,
        private readonly serviceC: ServiceC,
    ) {
        this.computeThing(
            this.serviceA.getA(), this.serviceB.getB(), this.serviceC.getC(),
        );
        this.otherDataStructure = computeOther(this.onlyUsedInCtor);
    }

    private computeThing(a: A, b: B, c: C) {
        this.onlyUsedInCtor = someFunctionOf(a, b, c);
    }
}

```

```
class MyClass {
    private readonly otherDataStructure = ...;
    constructor(
        // 正例把服务写成普通构造参数，构造函数结束时它们就会被丢掉，实例上不留下无用字段。
        serviceA: ServiceA,
        serviceB: ServiceB,
        serviceC: ServiceC,
    ) {
        // 正例用构造函数里的局部常量保存中间结果，实例字段只留下构造完成之后还要读的数据。
        const onlyUsedInCtor =
            someFunctionOf(serviceA.getA(), serviceB.getB(), serviceC.getC());
        this.otherDataStructure = computeOther(onlyUsedInCtor);
    }
}

```

#### Class method declarations

Class method declarations must not use a semicolon to separate individual method declarations:

```
class Foo {
    doThing() {
        console.log("A");
    }
}

```

```
class Foo {
    doThing() {
        console.log("A");
    };  // 方法之间不要加分号。这个分号会让方法声明看起来像一条表达式语句，而不是类成员，本例就是这样。
}

```

Method declarations should be separated from surrounding code by a single blank line:

```
class Foo {
    doThing() {
        console.log("A");
    }

    getOtherThing(): number {
        return 4;
    }
}

```

```
class Foo {
    doThing() {
        console.log("A");
    }
    getOtherThing(): number {
        return 4;
    }
}

```

##### Overriding toString

The `toString` method may be overridden, but must always succeed and never have visible side effects.

Tip: Beware, in particular, of calling other methods from toString, since exceptional conditions could lead to infinite loops.

#### Static methods

##### Avoid private static methods

Where it does not interfere with readability, prefer module-local functions over private static methods.

##### Do not rely on dynamic dispatch

Code should not rely on dynamic dispatch of static methods. Static methods should only be called on the base class itself (which defines it directly). Static methods should not be called on variables containing a dynamic instance that may be either the constructor or a subclass constructor (and must be defined with `@nocollapse` if this is done), and must not be called directly on a subclass that doesn’t define the method itself.

Disallowed:

```
// 下面的例子都基于这个基类。基类自己这样写是可以的，问题出在后面通过子类去调用，本例就是这样。
class Base {
    /**
     * 静态方法上的 nocollapse 用来阻止编译器把这个方法折叠掉，标记本身不改变运行结果。
     * @nocollapse
     */
    static foo() {}
}
class Sub extends Base {}

// 不鼓励把静态方法当成值传来传去再调用，调用点看不出方法实际定义在哪个构造函数上。
function callFoo(cls: typeof Base) {
    cls.foo();
}

// 子类没有自己声明这个静态方法时，禁止通过子类去调用父类的静态方法，继承关系在这里会误导读者。
Sub.foo();

// 静态方法里禁止读取 this。它不一定指向当前构造函数，写出来的人很容易以为拿到的是子类。
class MyClass {
    static foo() {
        return this.staticField;
    }
}
MyClass.staticField = 1;

```

##### Avoid static `this` references

Code must not use `this` in a static context.

JavaScript allows accessing static fields through `this`. Different from other languages, static fields are also inherited.

```
class ShoeStore {
    static storage: Storage = ...;

    static isAvailable(s: Shoe) {
        // 反例在静态方法里用 this 读取 storage，子类覆盖字段后这个 this 会指向谁并不明显。
        return this.storage.has(s.id);
    }
}

class EmptyShoeStore extends ShoeStore {
    // 子类用同名静态字段覆盖父类的 storage，静态方法若依赖 this，就会读到这份覆盖后的值。
    static storage: Storage = EMPTY_STORE;
}

```

Why?

This code is generally surprising: authors might not expect that static fields can be accessed through the this pointer, and might be surprised to find that they can be overridden - this feature is not commonly used.

This code also encourages an anti-pattern of having substantial static state, which causes problems with testability.

#### Constructors

Constructor calls must use parentheses, even when no arguments are passed:

```
const x = new Foo;

```

```
const x = new Foo();

```

Omitting parentheses can lead to subtle mistakes. These two lines are not equivalent:

```
new Foo().Bar();
new Foo.Bar();

```

It is unnecessary to provide an empty constructor or one that simply delegates into its parent class because ES2015 provides a default class constructor if one is not specified. However constructors with parameter properties, visibility modifiers or parameter decorators should not be omitted even if the body of the constructor is empty.

```
class UnnecessaryConstructor {
    constructor() {}
}

```

```
class UnnecessaryConstructorOverride extends Base {
        constructor(value: number) {
            super(value);
        }
}

```

```
class DefaultConstructor {
}

class ParameterProperties {
    constructor(private myService) {}
}

class ParameterDecorators {
    constructor(@SideEffectDecorator myService) {}
}

class NoInstantiation {
    private constructor() {}
}

```

The constructor should be separated from surrounding code both above and below by a single blank line:

```
class Foo {
    myField = 10;

    constructor(private readonly ctorParam) {}

    doThing() {
        console.log(ctorParam.getThing() + myField);
    }
}

```

```
class Foo {
    myField = 10;
    constructor(private readonly ctorParam) {}
    doThing() {
        console.log(ctorParam.getThing() + myField);
    }
}

```

#### Class members

##### No #private fields

Do not use private fields (also known as private identifiers):

```
class Clazz {
    #ident = 1;
}

```

Instead, use TypeScript’s visibility annotations:

```
class Clazz {
    private ident = 1;
}

```

Private identifiers cause substantial emit size and performance regressions when down-leveled by TypeScript, and are unsupported before ES2015. They can only be downleveled to ES2015, not lower. At the same time, they do not offer substantial benefits when static type checking is used to enforce visibility.

##### Use readonly

Mark properties that are never reassigned outside of the constructor with the `readonly` modifier (these need not be deeply immutable).

##### Parameter properties

Rather than plumbing an obvious initializer through to a class member, use a TypeScript parameter property.

```
class Foo {
    private readonly barService: BarService;

    constructor(barService: BarService) {
        this.barService = barService;
    }
}

```

```
class Foo {
    constructor(private readonly barService: BarService) {}
}

```

If the parameter property needs documentation, use an `@param` JSDoc tag.

##### Field initializers

If initializing a class member does not rely on a constructor parameter or a parameter property, initialize it where it’s declared. This sometimes lets you drop the constructor entirely.

```
class Foo {
    private readonly userList: string[];

    constructor() {
        this.userList = [];
    }
}

```

```
class Foo {
    private readonly userList: string[] = [];
}

```

It is possible to reference parameter properties from field initializers due to the way TypeScript transpiles this pattern to JavaScript. This transpilation is changing to match JavaScript language semantics, and referencing a parameter property from a field initializer will become a TypeScript compiler error, so this pattern should be avoided.

```
class Foo {
    // 反例在字段初始化器里读取 this.state，而 state 要等构造函数体才赋值，这时读到的是未初始化的值。
    private readonly userList = initializeUserList(this.state);

    constructor(private readonly state: InitialState) {}
}

```

```
class Foo {
    // 正例把 userList 的类型先声明出来，真正的赋值放在构造函数里，此时参数 state 已经可用。
    private readonly userList: string[];

    // 状态只在构造函数里用来计算 userList，就可以写成普通参数，不必变成实例上的参数属性。
    constructor(state: InitialState) {
        this.userList = initializeUserList(state);
    }
}

```

Tip: Properties should never be added to or removed from an instance after the constructor is finished, since it significantly hinders VMs’ ability to optimize classes’ “shape”. Optional fields that may be filled in later should be explicitly initialized to `undefined` to prevent later shape changes.

##### Properties used outside of class lexical scope

Properties used from outside the lexical scope of their containing class, must not use `private` visibility, as they are used outside of the lexical scope of their containing class.

Exception: Angular component properties used only from a template are allowed to use `private` visibility.

Use either `protected` or `public` as appropriate to the property in question.

TypeScript code must not use `obj['foo']` to bypass the visibility of a property.

Why?

When a property is `private`, you are declaring to both automated systems and humans that the property accesses are scoped to the methods of the declaring class, and they will rely on that. For example, a check for unused code will flag a private property that appears to be unused, even if some other file manages to bypass the visibility restriction.

Though it might appear that `obj['foo']` can bypass visibility in the TypeScript compiler, this pattern can be broken by rearranging the build rules, and also violates optimization compatibility.

##### Getters and setters

Getters and setters, also known as accessors, for class members may be used. The getter method must be a pure function (i.e., result is consistent and has no side effects: getters must not change observable state). They are also useful as a means of restricting the visibility of internal or verbose implementation details (shown below).

```
class Foo {
    constructor(private readonly someService: SomeService) {}

    get someMember(): string {
        return this.someService.someVariable;
    }

    set someMember(newValue: string) {
        this.someService.someVariable = newValue;
    }
}

```

```
class Foo {
    nextId = 0;
    get next() {
        return this.nextId++;  // 反例的 getter 每次读取都让 nextId 加一，读取变成了会改变状态的操作。
    }
}

```

If an accessor is used to hide a class property, the hidden property may be prefixed or suffixed with any whole word, like `internal` or `wrapped`. When using these private properties, access the value through the accessor whenever possible. At least one accessor for a property must be non-trivial: do not define “pass-through” accessors only for the purpose of hiding a property. Instead, make the property public (or consider making it `readonly` rather than just defining a getter with no setter).

```
class Foo {
    private wrappedBar = "";
    get bar() {
        return this.wrappedBar || "bar";
    }

    set bar(wrapped: string) {
        this.wrappedBar = wrapped.trim();
    }
}

```

```
class Bar {
    private barInternal = "";
    // 这对读写器只是转发字段，没有校验或换算，应直接把 bar 做成公开字段，不要包一层。
    get bar() {
        return this.barInternal;
    }

    set bar(value: string) {
        this.barInternal = value;
    }
}

```

Getters and setters must not be defined using `Object.defineProperty`, since this interferes with property renaming.

##### Computed properties

Computed properties may only be used in classes when the property is a symbol. Dict-style properties (that is, quoted or computed non-symbol keys) are not allowed. A `[Symbol.iterator]` method should be defined for any classes that are logically iterable. Beyond this, `Symbol` should be used sparingly.

Tip: be careful of using any other built-in symbols (e.g. `Symbol.isConcatSpreadable`) as they are not polyfilled by the compiler and will therefore not work in older browsers.

#### Visibility

Restricting visibility of properties, methods, and entire types helps with keeping code decoupled.

- Limit symbol visibility as much as possible.
- Consider converting private methods to non-exported functions within the same file but outside of any class, and moving private properties into a separate, non-exported class.
- TypeScript symbols are public by default. Never use the `public` modifier except when declaring non-readonly public parameter properties (in constructors).

```
class Foo {
    public bar = new Bar();  // 字段默认就是公开的，再写 public 没有增加信息，应删掉这个修饰符，避免无意义的重复。

    // readonly 已经说明这是属性，属性默认公开，再写 public 是重复的。
    constructor(public readonly baz: Baz) {}
}

```

```
class Foo {
    bar = new Bar();  // 正例不写 public，字段保持默认的公开可见性，读者不会多看到一个无意义的修饰符。

    // 非只读的参数属性必须写出 public，否则它只是构造参数，不会变成实例上的字段。
    constructor(public baz: Baz) {}
}

```

#### Disallowed class patterns

##### Do not manipulate `prototype` s directly

The `class` keyword allows clearer and more readable class definitions than defining `prototype` properties. Ordinary implementation code has no business manipulating these objects. Mixins and modifying the prototypes of built-in objects are explicitly forbidden.

Exception: Framework code (such as Polymer, or Angular) may need to use `prototype` s, and should not resort to even-worse workarounds to avoid doing so.

### Functions

#### Terminology

There are many different types of functions, with subtle distinctions between them. This guide uses the following terminology, which aligns with MDN:

- “function declaration”: a declaration (i.e. not an expression) using the `function` keyword
- “function expression”: an expression, typically used in an assignment or passed as a parameter, using the `function` keyword
- “arrow function”: an expression using the `=>` syntax
- “block body”: right hand side of an arrow function with braces
- “concise body”: right hand side of an arrow function without braces

Methods and classes/constructors are not covered in this section.

#### Prefer function declarations for named functions

Prefer function declarations over arrow functions or function expressions when defining named functions.

```
function foo() {
    return 42;
}

```

```
const foo = () => 42;

```

Arrow functions may be used, for example, when an explicit type annotation is required.

```
interface SearchFunction {
    (source: string, subString: string): boolean;
}

const fooSearch: SearchFunction = (source, subString) => { ... };

```

#### Nested functions

Functions nested within other methods or functions may use function declarations or arrow functions, as appropriate. In method bodies in particular, arrow functions are preferred because they have access to the outer `this`.

#### Do not use function expressions

Do not use function expressions. Use arrow functions instead.

```
bar(() => { this.doSomething(); })

```

```
bar(function() { ... })

```

Exception: Function expressions may be used only if code has to dynamically rebind `this` (but this is discouraged), or for generator functions (which do not have an arrow syntax).

#### Arrow function bodies

Use arrow functions with concise bodies (i.e. expressions) or block bodies as appropriate.

```
// 文件顶层的具名函数用函数声明，不要写成赋给变量的函数表达式，调用点才能按名字提升。
function someFunction() {
    // 箭头函数的函数体需要多条语句时，用花括号块体，并把结果显式 return 出去。
    const receipts = books.map((b: Book) => {
        const receipt = payMoney(b.price);
        recordTransaction(receipt);
        return receipt;
    });

    // 返回值会被外层使用时，箭头函数可以写成不带花括号的表达式体，结果就是该表达式的值。
    const longThings =
            myValues.filter((v) => v.length > 1000).map((v) => String(v));

    function payMoney(amount: number) {
        // 嵌套的函数声明可以用来拆小步骤，但它没有外层的 this，不要在里面读取实例字段。
    }

    // 需要保留外层 this 的短函数可以赋给 const，不要为了起名改回函数声明。
    const computeTax = (amount: number) => amount * 0.12;
}

```

Only use a concise body if the return value of the function is actually used. The block body makes sure the return type is `void` then and prevents potential side effects.

```
// 反例把返回值用不到的调用写成表达式体，调用方会意外拿到 console.log 的返回值。
myPromise.then((v) => console.log(v));
// 反例的表达式体类型上能赋给 void 函数，但运行时仍然会把 1 传出去，调用方收得到。
let f: () => void;
f = () => 1;

```

```
// 返回值不会被使用时写成块体，块体的完成值是 void，不会把内部表达式泄漏出去。
myPromise.then((v) => {
    console.log(v);
});
// 即使最后会返回值，中间步骤变长时也可以用块体，把中间量写成局部常量再返回，本例就是这样。
const transformed = [1, 2, 3].map((v) => {
    const intermediate = someComplicatedExpr(v);
    const more = acrossManyLines(intermediate);
    return worthWrapping(more);
});
// 必须留在表达式体里时，用 void 运算符丢掉返回值，避免把日志函数的结果传给 then。
myPromise.then((v) => void console.log(v));

```

Tip: The `void` operator can be used to ensure an arrow function with an expression body returns `undefined` when the result is unused.

#### Rebinding `this`

Function expressions and function declarations must not use `this` unless they specifically exist to rebind the `this` pointer. Rebinding `this` can in most cases be avoided by using arrow functions or explicit parameters.

```
function clickHandler() {
    // 反例在普通函数里写 this，这个函数被拿去当点击处理函数时，this 不会是组件实例。
    this.textContent = "Hello";
}
// 把普通函数赋给 document.body.onclick 后，浏览器会把 this 设成 body，而不是定义函数时的对象。
document.body.onclick = clickHandler;

```

```
// 正例用箭头函数直接写 document.body，不依赖调用时绑定的 this。
document.body.onclick = () => { document.body.textContent = "hello"; };
// 也可以把目标元素当成显式参数，再用 bind 传入 body，调用点能看见 this 被固定成谁。
const setTextFn = (e: HTMLElement) => { e.textContent = "hello"; };
document.body.onclick = setTextFn.bind(null, document.body);

```

Prefer arrow functions over other approaches to binding `this`, such as `f.bind(this)`, `goog.bind(f, this)`, or `const self = this`.

#### Prefer passing arrow functions as callbacks

Callbacks can be invoked with unexpected arguments that can pass a type check but still result in logical errors.

Avoid passing a named callback to a higher-order function, unless you are sure of the stability of both functions’ call signatures. Beware, in particular, of less-commonly-used optional parameters.

```
// 反例把函数直接交给 map，数组下标会填进可选的 decimals 参数，格式化结果因此被截断。
const strs = [1.23, 4.56, 7.89].map(googFormat.numericValueToString);
// 反例的实际输出是截断后的字符串，小数位被 map 传入的下标改变，不再是原来的小数。

```

Instead, prefer passing an arrow-function that explicitly forwards parameters to the named callback.

```
// 正例用箭头函数只把数值传进格式化函数，数组下标不会再占据那个可选的小数位参数，本例就是这样。
const strs = [1.23, 4.56, 7.89].map((n) => googFormat.numericValueToString(n));
// 正例保留原来的小数，因为格式化函数只收到数值，没有收到 map 附带的数组下标。

// 这个局部函数的参数就是回调会收到的元素，可以安全地直接交给 filter，不必再包一层。
function dayFilter(element: string|null|undefined) {
    return element != null && element.endsWith("day");
}

const days = ["tuesday", undefined, "juice", "wednesday"].filter(dayFilter);

```

#### Arrow functions as properties

Classes usually should not contain properties initialized to arrow functions. Arrow function properties require the calling function to understand that the callee’s `this` is already bound, which increases confusion about what `this` is, and call sites and references using such handlers look broken (i.e. require non-local knowledge to determine that they are correct). Code should always use arrow functions to call instance methods (`const handler = (x) => { this.listener(x); };`), and should not obtain or pass references to instance methods (

`const handler = this.listener; handler(x);`

).

> Note: in some specific situations, e.g. when binding functions in a template, arrow functions as properties are useful and create much more readable code. Use judgement with this rule. Also, see the `Event Handlers` section below.

```
class DelayHandler {
    constructor() {
        // 把方法本身交给 setTimeout 后，回调里的 this 不再是 DelayHandler 实例，实例字段不会被写上。
        setTimeout(this.patienceTracker, 5000);
    }
    private patienceTracker() {
        this.waitedPatiently = true;
    }
}

```

```
// 箭头函数一般不要做成实例属性。属性箭头会在构造时绑定 this，看起来像忘记 bind 的方法。
class DelayHandler {
    constructor() {
        // 反例把属性箭头传给 setTimeout，调用点看不出 this 其实已经在字段初始化时被绑定。
        setTimeout(this.patienceTracker, 5000);
    }
    private patienceTracker = () => {
        this.waitedPatiently = true;
    }
}

```

```
// 正例在调用点用箭头函数包一层，this 的绑定出现在 setTimeout 旁边，而不是藏在字段里。
class DelayHandler {
    constructor() {
        // 能在调用点写箭头函数就不要再做一个实例属性，这个定时器回调只在这一处被使用，本例就是这样。
        setTimeout(() => {
            this.patienceTracker();
        }, 5000);
    }
    private patienceTracker() {
        this.waitedPatiently = true;
    }
}

```

#### Event handlers

Event handlers may use arrow functions when there is no need to uninstall the handler (for example, if the event is emitted by the class itself). If the handler requires uninstallation, arrow function properties are the right approach, because they automatically capture `this` and provide a stable reference to uninstall.

```
// 事件处理函数可以是调用点的箭头函数，也可以是为了稍后移除而保存下来的属性箭头，本例就是这样。
class Component {
    onAttached() {
        // 这个点击事件由组件自己发出，组件销毁时监听会一起消失，不必再单独调用移除函数，本例就是这样。
        this.addEventListener("click", () => {
            this.listener();
        });
        // listener 是稳定的函数引用，之后可以用同一个引用从 window 上摘掉监听。
        window.addEventListener("onbeforeunload", this.listener);
    }
    onDetached() {
        // 事件来自 window。不移除的话，已绑定的 listener 会一直抓住组件实例，组件无法被回收。
        window.removeEventListener("onbeforeunload", this.listener);
    }
    // 存在属性里的箭头函数在初始化时就绑定了 this，所以同一个属性引用可以用来添加和移除监听。
    private listener = () => {
        confirm("Do you want to exit the page?");
    }
}

```

Do not use `bind` in the expression that installs an event handler, because it creates a temporary reference that can’t be uninstalled.

```
// 每次 bind 都产生一个新函数，添加监听时的那个引用没有被保存，之后无法按同一个引用移除。
class Component {
    onAttached() {
        // bind 的返回值没有赋给字段，移除监听时拿不到当初注册的那个函数，监听会一直留着。
        window.addEventListener("onbeforeunload", this.listener.bind(this));
    }
    onDetached() {
        // 这里又 bind 了一次，得到的是另一个函数，removeEventListener 因此不会摘掉已经注册的监听。
        window.removeEventListener("onbeforeunload", this.listener.bind(this));
    }
    private listener() {
        confirm("Do you want to exit the page?");
    }
}

```

#### Parameter initializers

Optional function parameters may be given a default initializer to use when the argument is omitted. Initializers must not have any observable side effects. Initializers should be kept as simple as possible.

```
function process(name: string, extraContext: string[] = []) {}
function activate(index = 0) {}

```

```
// 反例把自增写进默认参数，每次调用即使不读 index，也会把全局计数器往前推一格。
let globalCounter = 0;
function newId(index = globalCounter++) {}

// 反例把可变数组当作默认值，各次调用会改到同一份列表，调用顺序因此互相耦合在一起。
class Foo {
    private readonly defaultPaths: string[];
    frobnicate(paths = defaultPaths) {}
}

```

Use default parameters sparingly. Prefer destructuring to create readable APIs when there are more than a small handful of optional parameters that do not have a natural order.

#### Prefer rest and spread when appropriate

Use a rest parameter instead of accessing `arguments`. Never name a local variable or parameter `arguments`, which confusingly shadows the built-in name.

```
function variadic(array: string[], ...numbers: number[]) {}

```

Use function spread syntax instead of `Function.prototype.apply`.

#### Formatting functions

Blank lines at the start or end of the function body are not allowed.

A single blank line may be used within function bodies sparingly to create logical groupings of statements.

Generators should attach the `*` to the `function` and `yield` keywords, as in `function* foo()` and `yield* iter`, rather than 

`function *foo()`

 or 

`yield *iter`

.

Parentheses around the left-hand side of a single-argument arrow function are recommended but not required.

Do not put a space after the `...` in rest or spread syntax.

```
function myFunction(...elements: number[]) {}
myFunction(...array, ...iterable, ...generator());

```

#### Function Length

Write small and focused functions and class methods.

Even though no hard limit is placed on function and method length, if it exceeds about 40 lines, think about whether it can be broken up without harming the structure of the program.

This is not an exact science, but here are some examples of signs that your method might be too complex:

- It has several levels of nesting.
- It consists of several separate blocks of code, that each require a comment to explain what it does.
- It has to handle different types of exceptions in different places.
- It can’t all fit on your screen at once.

If working with such a function proves to be difficult, you find that errors are hard to debug, or you want to use a piece of it in several different contexts, consider breaking up the function into smaller and more manageable pieces. Note that there is nothing wrong with a private helper method or class that is used only once; these can be a useful tool for making code more readable.

### this

Only use `this` in class constructors and methods, functions that have an explicit `this` type declared (e.g. `function func(this: ThisType, ...)`), or in arrow functions defined in a scope where `this` may be used.

Never use `this` to refer to the global object, the context of an `eval`, the target of an event, or unnecessarily `call()` ed or `apply()` ed functions.

```
this.alert("Hello");

```

### Primitive literals

#### String literals

##### Use double quotes

Ordinary string literals are delimited with double quotes (`"`), matching Prettier with `singleQuote` set to false and `printWidth` set to 120.

Exception: if a string contains a double-quote character, it may be delimited with single quotes to avoid escaping that quote.

##### No line continuations

Do not use line continuations (that is, ending a line inside a string literal with a backslash) in either ordinary or template string literals. Even though ES5 allows this, it can lead to tricky errors if any trailing whitespace comes after the slash, and is less obvious to readers.

Disallowed:

```
const LONG_STRING = "This is a very very very very very very very long string. \
        It inadvertently contains long stretches of spaces due to how the \
        continued lines are indented.";

```

Instead, write

```
const LONG_STRING = "This is a very very very very very very long string. " +
        "It does not contain long stretches of spaces because it uses " +
        "concatenated strings.";
const SINGLE_STRING =
        "http://it.is.also/acceptable_to_use_a_single_long_string_when_breaking_would_hinder_search_discoverability";

```

##### Template literals

Use template literals (delimited with backticks) over complex string concatenation, particularly if multiple string literals are involved. Template literals may span multiple lines.

If a template literal spans multiple lines, it does not need to follow the indentation of the enclosing block, though it may if the added whitespace does not matter.

Example:

```
function arithmetic(a: number, b: number) {
    return `Here is a table of arithmetic operations:
${a} + ${b} = ${a + b}
${a} - ${b} = ${a - b}
${a} * ${b} = ${a * b}
${a} / ${b} = ${a / b}`;
}

```

#### Number literals

Numbers may be specified in decimal, hex, octal, or binary. Use exactly `0x`, `0o`, and `0b` prefixes, with lowercase letters, for hex, octal, and binary, respectively. Never include a leading zero unless it is immediately followed by `x`, `o`, or `b`.

#### Type coercion

TypeScript code may use the `String()` and `Boolean()` (note: no `new`!) functions, string template literals, or `!!` to coerce types.

```
const bool = Boolean(0);
const str = String(aNumber);
const bool2 = !!str;
const str2 = `result: ${bool2}`;

```

Values of enum types (including unions of enum types and other types) must not be converted to booleans with `Boolean()` or `!!`, and must instead be compared explicitly with comparison operators.

```
enum SupportLevel {
    NONE,
    BASIC,
    ADVANCED,
}

const level: SupportLevel = ...;
let enabled = Boolean(level);

const maybeLevel: SupportLevel|undefined = ...;
enabled = !!maybeLevel;

```

```
enum SupportLevel {
    NONE,
    BASIC,
    ADVANCED,
}

const level: SupportLevel = ...;
let enabled = level !== SupportLevel.NONE;

const maybeLevel: SupportLevel|undefined = ...;
enabled = maybeLevel !== undefined && maybeLevel !== SupportLevel.NONE;

```

Why?

For most purposes, it doesn’t matter what number or string value an enum name is mapped to at runtime, because values of enum types are referred to by name in source code. Consequently, engineers are accustomed to not thinking about this, and so situations where it does matter are undesirable because they will be surprising. Such is the case with conversion of enums to booleans; in particular, by default, the first declared enum value is falsy (because it is 0) while the others are truthy, which is likely to be unexpected. Readers of code that uses an enum value may not even know whether it’s the first declared value or not.

Using string concatenation to cast to string is discouraged, as we check that operands to the plus operator are of matching types.

##### Coercing to numbers

Number parsing can fail in a wide variety of ways, with many surprising corner cases, and the different methods to parse numbers each have different and sometimes inconsistent behavior (e.g. whitespace, empty strings, scientific notation, overflow to infinity, radix prefixes, etc). Further, parsing at the wrong layer can often be a code smell. Code must check the output of any numeric coercion and explicitly handle any possible non-throwing failure cases (e.g. handling any `NaN` results).

Code must not use unary plus (e.g. `+str`) or `parseFloat` to coerce strings to numbers. The former is too easy to miss in a code review, and the latter silently ignores trailing garbage in the input string. In both cases, prefer `Number` instead.

Code must not use `parseInt` unless a non-decimal radix is required. In this case, the input string must be checked for validity (i.e. all characters are valid digits) before parsing to ensure trailing garbage is not silently ignored. The output must also be checked against `NaN`.

```
const x = +y;
const x1 = parseFloat(y1);

```

```
const x = Number(y);
if (!isFinite(x)) throw new Error(...);

```

##### Implicit coercion

Do not use explicit boolean coercions in conditional clauses that have implicit boolean coercion (specifically, the conditions in `if`, `for`, and `while` statements).

```
const foo: MyInterface|null = ...;
if (!!foo) {...}
while (!!foo) {...}

```

```
const foo: MyInterface|null = ...;
if (foo) {...}
while (foo) {...}

```

As with explicit conversions, values of enum types (including unions of enum types and other types) must not be implicitly coerced to booleans, and must instead be compared explicitly with comparison operators.

```
enum SupportLevel {
    NONE,
    BASIC,
    ADVANCED,
}

const level: SupportLevel = ...;
if (level) {...}

const maybeLevel: SupportLevel|undefined = ...;
if (maybeLevel) {...}

```

```
enum SupportLevel {
    NONE,
    BASIC,
    ADVANCED,
}

const level: SupportLevel = ...;
if (level !== SupportLevel.NONE) {...}

const maybeLevel: SupportLevel|undefined = ...;
if (maybeLevel !== undefined && maybeLevel !== SupportLevel.NONE) {...}

```

Other types of values may be either implicitly coerced to booleans or compared explicitly with comparison operators:

```
// 长度需要和零比较时可以写成大于零，读者不用记住空数组在布尔上下文里算真还是算假。
if (arr.length > 0) {...}
// 数组长度也可以直接放进条件里，零是假值，非零是真值，和显式大于零的写法都允许，本例就是这样。
if (arr.length) {...}

```

### Control structures

#### Control flow statements and blocks

Control flow statements (`if`, `else`, `for`, `do`, `while`, etc) always use braced blocks for the containing code, even if the body contains only a single statement. The first statement of a non-empty block must begin on its own line.

```
for (let i = 0; i < x; i++) {
    doSomethingWith(i);
}

if (x) {
    doSomethingWithALongMethodNameThatForcesANewLine(x);
}

```

```
if (x)
    doSomethingWithALongMethodNameThatForcesANewLine(x);

for (let i = 0; i < x; i++) doSomethingWith(i);

```

Exception: `if` statements fitting on one line may elide the block.

```
if (x) x.doFoo();

```

##### Assignment in control statements

Prefer to avoid assignment of variables inside control statements. Assignment can be easily mistaken for equality checks inside control statements.

```
if (x = someFunction()) {
    // 条件里的赋值很容易被看成相等比较，所以不要在 if 的括号里给变量赋值，本例就是这样。
}

```

```
x = someFunction();
if (x) {
    // 这里省掉了和本条规则无关的语句，读者只需要看留下的那几行就能判断写法是否符合要求。
}

```

In cases where assignment inside the control statement is preferred, enclose the assignment in additional parenthesis to indicate it is intentional.

```
while ((x = someFunction())) {
    // 必须在循环条件里赋值时，用双层括号标明这是有意的赋值，而不是把等于号写成了赋值。
}

```

##### Iterating containers

Prefer `for (... of someArr)` to iterate over arrays. `Array.prototype.forEach` and vanilla `for` loops are also allowed:

```
for (const x of someArr) {
    // for-of 里的 x 是数组元素本身，不是下标，需要下标时应改用 entries 或计数循环。
}

for (let i = 0; i < someArr.length; i++) {
    // 只有确实需要下标时才写计数循环，否则用 for-of，避免多维护一个只为取元素的索引。
    const x = someArr[i];
    // 这里省掉了和本条规则无关的语句，读者只需要看留下的那几行就能判断写法是否符合要求。
}
for (const [i, x] of someArr.entries()) {
    // 需要同时拿到下标和元素时，用 entries 解构，不必再手写从零开始的计数器。
}

```

`for`-`in` loops may only be used on dict-style objects (see below for more info). Do not use `for (... in ...)` to iterate over arrays as it will counterintuitively give the array’s indices (as strings!), not values:

```
for (const x in someArray) {
    // 对数组使用 for-in 时，x 是下标字符串，不是元素，这个循环几乎总是写错了。
}

```

`Object.prototype.hasOwnProperty` should be used in `for`-`in` loops to exclude unwanted prototype properties. Prefer `for`-`of` with `Object.keys`, `Object.values`, or `Object.entries` over `for`-`in` when possible.

```
for (const key in obj) {
    if (!obj.hasOwnProperty(key)) continue;
    doWork(key, obj[key]);
}
for (const key of Object.keys(obj)) {
    doWork(key, obj[key]);
}
for (const value of Object.values(obj)) {
    doWorkValOnly(value);
}
for (const [key, value] of Object.entries(obj)) {
    doWork(key, value);
}

```

#### Grouping parentheses

Optional grouping parentheses are omitted only when the author and reviewer agree that there is no reasonable chance that the code will be misinterpreted without them, nor would they have made the code easier to read. It is not reasonable to assume that every reader has the entire operator precedence table memorized.

Do not use unnecessary parentheses around the entire expression following `delete`, `typeof`, `void`, `return`, `throw`, `case`, `in`, `of`, or `yield`.

#### Exception handling

Exceptions are an important part of the language and should be used whenever exceptional cases occur.

Custom exceptions provide a great way to convey additional error information from functions. They should be defined and used wherever the native `Error` type is insufficient.

Prefer throwing exceptions over ad-hoc error-handling approaches (such as passing an error container reference type, or returning an object with an error property).

##### Instantiate errors using `new`

Always use `new Error()` when instantiating exceptions, instead of just calling `Error()`. Both forms create a new `Error` instance, but using `new` is more consistent with how other objects are instantiated.

```
throw new Error("Foo is not a valid bar.");

```

```
throw Error("Foo is not a valid bar.");

```

##### Only throw errors

Although JavaScript allows throwing arbitrary values, stack traces are only populated if the thrown value is an `Error`. Do not throw primitives (including strings, numbers, null or undefined) or objects that are not instances of `Error` or a subclass. This restriction also extends to all APIs that may throw their arguments, including `Promise.reject` or `AbortSignal`’s various `abort` methods.

```
// 反例抛出字符串，调用栈上没有 Error 对象，捕获方无法记录这段代码的抛出位置。
throw "oh noes!";
// 下面几行把同一条抛出规则用在 Promise 上，拒绝原因必须是 Error，不能是字符串。
new Promise((resolve, reject) => void reject("oh noes!"));
Promise.reject();
Promise.reject("oh noes!");
// 下面几行把同一条规则用在中止信号上，原因必须是 Error，或者不传原因，不要传字符串。
new AbortController().abort("my custom abort error");
AbortSignal.abort("my other custom abort error");

```

Instead, only throw (subclasses of) `Error`:

```
// 只抛出 Error。捕获方可以读取 message 和栈，字符串做不到这两件事。
throw new Error("oh noes!");
// 可以抛出 Error 的子类，调用方仍然能按 Error 处理，同时保留更具体的类型。
class MyError extends Error {}
throw new MyError("my oh noes!");
// 下面几行把同一条抛出规则用在 Promise 上，拒绝原因必须是 Error，不能是字符串。
// 这个 Promise 只解决、不拒绝，因此不必为了形式再写一个 reject 参数。
new Promise((resolve) => resolve());
new Promise((resolve, reject) => void reject(new Error("oh noes!")));
Promise.reject(new Error("oh noes!"));
// 下面几行把同一条规则用在中止信号上，原因必须是 Error，或者不传原因，不要传字符串。
new AbortController().abort();  // 中止时可以不给原因，调用方只需要知道信号已经中止，不必再伪造一条错误文本，本例就是这样。
AbortSignal.abort();
new AbortController().abort(new Error("my custom abort error"));
AbortSignal.abort(new Error("my other custom abort error"));

```

Note: Calling `AbortController#abort` or `AbortSignal.abort` with no arguments is valid because a new “AbortError” `DOMException` will be created by default and assigned as the `AbortSignal#reason` (see MDN).

##### Catching and rethrowing

When catching errors, code should assume that all thrown errors are instances of `Error`.

```
function assertIsError(e: unknown): asserts e is Error {
    if (!(e instanceof Error)) throw new Error("e is not an Error");
}

try {
    doSomething();
} catch (e: unknown) {
    // 进入 catch 后先收窄成 Error。不要为字符串或其他值写分支，除非这个 API 明确会抛出它们。
    assertIsError(e);
    displayError(e.message);
    // 处理完日志之后可以把原来的 Error 继续抛出，让上层保留最初的调用栈，本例就是这样。
    throw e;
}

```

Exception handlers must not defensively handle non-`Error` types unless the called API is conclusively known to throw non-`Error` s in violation of the above rule. In that case, a comment should be included to specifically identify where the non-`Error` s originate.

```
try {
    badApiThrowingStrings();
} catch (e: unknown) {
    // 这个 API 明确会抛出字符串而不是 Error，只有在这种已经证实的情况下才按字符串处理。
    if (typeof e === "string") { ... }
}

```

Avoid overly defensive programming. Repeating the same defenses against a problem that will not exist in most code leads to boiler-plate code that is not useful.

##### Empty catch blocks

It is very rarely correct to do nothing in response to a caught exception. When it truly is appropriate to take no action whatsoever in a catch block, the reason this is justified is explained in a comment.

```
    try {
        return handleNumericResponse(response);
    } catch (e: unknown) {
        // 数值解析失败时落到文本处理。catch 里故意不改响应，只是换一条解析路径继续。
    }
    return handleTextResponse(response);

```

Disallowed:

```
    try {
        shouldFail();
        fail("expected an error");
    } catch (expected: unknown) {
    }

```

Tip: Unlike in some other languages, patterns like the above simply don’t work since this will catch the error thrown by `fail`. Use `assertThrows()` instead.

##### ErrorOptions cause must be an Error object

When passing an argument for the ErrorOptions parameter, the `cause` property must be initialized with a subtype of error. This effectively creates a chain of error objects with useful stack traces.

```
try {
    ...
} catch (e: unknown) {
    if (e instanceof Error) {
        throw new Error("Something went wrong", {cause: e});
    }
}

```

```
const status = doSomething();
if (status !== success) {
    throw new Error("doSomething failed", {cause: status});
}

```

If the `cause` initializer refers to the catch clause variable of type unknown, it’s ok to omit a type check, since our codebase assumes you cannot throw anything other than an `Error` object.

```
try {
    ...
} catch (e: unknown) {
    // 新的 Error 把原来的值放进 cause，这里不必再判断 e 是不是 Error 的子类。
    throw new Error("Something went wrong", {cause: e});
}

```

In TypeScript, type `Error` happens to be assignable to `ErrorOptions`. Thus it is possible to pass an error object accidentally as the ErrorOptions parameter, which is very likely a bug in the code.

```
try {
    ...
} catch (e: unknown) {
    if (e instanceof Error) {
        throw new Error("Something went wrong", e);
    }
}

```

#### Switch statements

All `switch` statements must contain a `default` statement group, even if it contains no code. The `default` statement group must be last.

```
switch (x) {
    case Y:
        doSomethingElse();
        break;
    default:
        // 这个分支没有业务动作。空的 default 或空的 catch 必须说明为什么可以什么都不做。
}

```

Within a switch block, each statement group either terminates abruptly with a `break`, a `return` statement, or by throwing an exception. Non-empty statement groups (`case ...`) must not fall through (enforced by the compiler):

```
switch (x) {
    case X:
        doSomething();
        // 反例从一个 case 掉进下一个 case，这种贯穿是禁止的，每个分支都要 break 或 return。
    case Y:
        // 这里省掉了和本条规则无关的语句，读者只需要看留下的那几行就能判断写法是否符合要求。
}

```

Empty statement groups are allowed to fall through:

```
switch (x) {
    case X:
    case Y:
        doSomething();
        break;
    default:  // 这个分支没有业务动作。空的 default 或空的 catch 必须说明为什么可以什么都不做。
}

```

#### Equality checks

Always use triple equals (`===`) and not equals (`!==`). The double equality operators cause error prone type coercions that are hard to understand and slower to implement for JavaScript Virtual Machines. See also the JavaScript equality table.

```
if (foo == "bar" || baz != bam) {
    // 反例用宽松相等，类型转换会让不同的值比出真，读者无法从运算符看出实际比较了什么。
}

```

```
if (foo === "bar" || baz !== bam) {
    // 正例用严格相等，null 和 undefined 不会被悄悄转成别的值，比较结果就是这两个值本身。
}

```

Exception: Comparisons to the literal `null` value may use the `==` and `!=` operators to cover both `null` and `undefined` values.

```
if (foo == null) {
    // foo == null 同时覆盖 null 和 undefined，这是严格相等之外少数允许的宽松比较。
}

```

#### Type and non-nullability assertions

Type assertions (`x as SomeType`) and non-nullability assertions (`y!`) are unsafe. Both only silence the TypeScript compiler, but do not insert any runtime checks to match these assertions, so they can cause your program to crash at runtime.

Because of this, you should not use type and non-nullability assertions without an obvious or explicit reason for doing so.

Instead of the following:

```
(x as Foo).foo();

y!.bar();

```

When you want to assert a type or non-nullability the best answer is to explicitly write a runtime check that performs that check.

```
// 下面的示例假定 Foo 是一个类，instanceof 才能用来收窄 x 的类型。
if (x instanceof Foo) {
    x.foo();
}

if (y) {
    y.bar();
}

```

Sometimes due to some local property of your code you can be sure that the assertion form is safe. In those situations, you should add clarification to explain why you are ok with the unsafe behavior:

```
// 这里把 x 断言成 Foo。断言会绕过检查，所以前面的理由必须写清楚，不能只留下省略号。
(x as Foo).foo();

// 非空断言表示 y 在这里不可能是 null 或 undefined，注释要写出这个前提从哪来。
y!.bar();

```

If the reasoning behind a type or non-nullability assertion is obvious, the comments may not be necessary. For example, generated proto code is always nullable, but perhaps it is well-known in the context of the code that certain fields are always provided by the backend. Use your judgement.

##### Type assertion syntax

Type assertions must use the `as` syntax (as opposed to the angle brackets syntax). This enforces parentheses around the assertion when accessing a member.

```
const x = (<Foo>z).length;
const y = <Foo>z.length;

```

```
// 把 z 断言成 Foo 后再读 length。注释要说明为什么 z 在这里一定是 Foo。
const x = (z as Foo).length;

```

##### Double assertions

From the TypeScript handbook, TypeScript only allows type assertions which convert to a more specific or less specific version of a type. Adding a type assertion (`x as Foo`) which does not meet this criteria will give the error: “Conversion of type ‘X’ to type ‘Y’ may be a mistake because neither type sufficiently overlaps with the other.”

If you are sure an assertion is safe, you can perform a double assertion. This involves casting through `unknown` since it is less specific than all types.

```
// 双重断言会绕过中间类型的检查，更要写明 x 为什么在这里可以当成 Foo，而不是别的类型。
(x as unknown as Foo).fooMethod();

```

Use `unknown` (instead of `any` or `{}`) as the intermediate type.

##### Type assertions and object literals

Use type annotations (`: Foo`) instead of type assertions (`as Foo`) to specify the type of an object literal. This allows detecting refactoring bugs when the fields of an interface change over time.

```
interface Foo {
    bar: number;
    baz?: string;  // 这个可选字段以前叫 bam，后来改名为 baz。类型断言不会帮调用方发现还在使用的旧名字。
}

const foo = {
    bar: 123,
    bam: "abc",  // 反例通过断言把对象当成 Foo，多余的 bam 字段不会报错，错误被断言藏掉了。
} as Foo;

function func() {
    return {
        bar: 123,
        bam: "abc",  // 反例通过断言把对象当成 Foo，多余的 bam 字段不会报错，错误被断言藏掉了。
    } as Foo;
}

```

```
interface Foo {
    bar: number;
    baz?: string;
}

const foo: Foo = {
    bar: 123,
    bam: "abc",  // 正例给对象标上 Foo 类型，bam 不是 Foo 的字段，编译器会在这里报错。
};

function func(): Foo {
    return {
        bar: 123,
        bam: "abc",  // 正例给对象标上 Foo 类型，bam 不是 Foo 的字段，编译器会在这里报错。
    };
}

```

#### Keep try blocks focused

Limit the amount of code inside a try block, if this can be done without hurting readability.

```
try {
    const result = methodThatMayThrow();
    use(result);
} catch (error: unknown) {
    // 这里省掉了和本条规则无关的语句，读者只需要看留下的那几行就能判断写法是否符合要求。
}

```

```
let result;
try {
    result = methodThatMayThrow();
} catch (error: unknown) {
    // 这里省掉了和本条规则无关的语句，读者只需要看留下的那几行就能判断写法是否符合要求。
}
use(result);

```

Moving the non-throwable lines out of the try/catch block helps the reader learn which method throws exceptions. Some inline calls that do not throw exceptions could stay inside because they might not be worth the extra complication of a temporary variable.

Exception: There may be performance issues if try blocks are inside a loop. Widening try blocks to cover a whole loop is ok.

### Decorators

Decorators are syntax with an `@` prefix, like `@MyDecorator`.

Do not define new decorators. Only use the decorators defined by frameworks:

- Angular (e.g. `@Component`, `@NgModule`, etc.)
- Polymer (e.g. `@property`)

Why?

We generally want to avoid decorators, because they were an experimental feature that have since diverged from the TC39 proposal and have known bugs that won’t be fixed.

When using decorators, the decorator must immediately precede the symbol it decorates, with no empty lines between:

```
/** 文档注释要写在装饰器前面，这样编辑器在装饰器元数据旁边也能显示这段说明，本例就是这样。 */
@Component({...})  // 装饰器和类声明之间不要插空行，空行会让文档注释和类看起来不再相连，本例就是这样。
class MyComp {
    @Input() myField: string;  // 字段的装饰器可以和字段写在同一行，字段名仍然紧跟在装饰器后面，不必为了短装饰器换行。

    @Input()
    myOtherField: string;  // 装饰器参数变长时可以单独占一行，字段声明再换到下一行，两种写法不要在无故时混用。
}

```

### Disallowed features

#### Wrapper objects for primitive types

TypeScript code must not instantiate the wrapper classes for the primitive types `String`, `Boolean`, and `Number`. Wrapper classes have surprising behavior, such as `new Boolean(false)` evaluating to `true`.

```
const s = new String("hello");
const b = new Boolean(false);
const n = new Number(5);

```

The wrappers may be called as functions for coercing (which is preferred over using `+` or concatenating the empty string) or creating symbols. See type coercion for more information.

#### Automatic Semicolon Insertion

Do not rely on Automatic Semicolon Insertion (ASI). Explicitly end all statements using a semicolon. This prevents bugs due to incorrect semicolon insertions.

#### Const enums

Code must not use `const enum`; use plain `enum` instead.

TypeScript enums already cannot be mutated; `const enum` is a separate language feature related to optimization that makes the enum invisible to JavaScript users of the module.

#### Debugger statements

Debugger statements must not be included in production code.

```
function debugMe() {
    debugger;
}

```

#### `with`

Do not use the `with` keyword. It makes your code harder to understand and has been banned in strict mode since ES5.

#### Dynamic code evaluation

Do not use `eval` or the `Function(...string)` constructor (except for code loaders). These features are potentially dangerous and simply do not work in environments using strict Content Security Policies.

#### Non-standard features

Do not use non-standard ECMAScript or Web Platform features.

This includes:

- Old features that have been marked deprecated or removed entirely from ECMAScript / the Web Platform (see MDN)
- New ECMAScript features that are not yet standardized 

- Avoid using features that are in current TC39 working draft or currently in the proposal process
- Use only ECMAScript features defined in the current ECMA-262 specification
- Proposed but not-yet-complete web standards: 

- WHATWG proposals that have not completed the proposal process.
- Non-standard language “extensions” (such as those provided by some external transpilers)

Projects targeting specific JavaScript runtimes, such as latest-Chrome-only, Chrome extensions, Node.JS, Electron, can obviously use those APIs. Use caution when considering an API surface that is proprietary and only implemented in some browsers; consider whether there is a common library that can abstract this API surface away for you.

#### Modifying built-in objects

Never modify built-in types, either by adding methods to their constructors or to their prototypes. Avoid depending on libraries that do this.

Do not add symbols to the global object unless absolutely necessary (e.g. required by a third-party API).

## Naming

### Identifiers

Identifiers must use only ASCII letters, digits, underscores (for constants and structured test method names), and (rarely) the ‘$’ sign.

#### Naming style

TypeScript expresses information in types, so names should not be decorated with information that is included in the type. (See also Testing Blog for more about what not to include.)

Some concrete examples of this rule:

- Do not use trailing or leading underscores for private properties or methods.
- Do not use the `opt_` prefix for optional parameters. 

- For accessors, see accessor rules below.
- Do not mark interfaces specially (

`IMyInterface`

 or 

`MyFooInterface`

) unless it’s idiomatic in its environment. When introducing an interface for a class, give it a name that expresses why the interface exists in the first place (e.g. `class TodoItem` and `interface TodoItemStorage` if the interface expresses the format used for storage/serialization in JSON).
- Suffixing `Observable` s with `$` is a common external convention and can help resolve confusion regarding observable values vs concrete values. Judgement on whether this is a useful convention is left up to individual teams, but should be consistent within projects.

#### Descriptive names

Names must be descriptive and clear to a new reader. Do not use abbreviations that are ambiguous or unfamiliar to readers outside your project, and do not abbreviate by deleting letters within a word.

- Exception: Variables that are in scope for 10 lines or fewer, including arguments that are not part of an exported API, may use short (e.g. single letter) variable names.

```
// 正例的名字按完整单词拼写，常见缩写只保留读者不用查表就能懂的那几个，其余单词写全。
errorCount  // errorCount 不删字母，读者不用猜 error 和 count 各自被砍掉了哪一部分。
dnsConnectionIndex  // DNS 是读者公认的缩写，可以留在 dnsConnectionIndex 里，后面的单词仍然写全。
referrerUrl  // URL 同样是公认缩写，referrerUrl 里保留它，不要展开成一长串单词。
customerId  // Id 在这个代码库里就是标识，customerId 不会被读成别的意思，不必改成 Identifier。

```

```
// 反例这些名字或者删了单词内部的字母，或者只有本小组才懂，新代码不要再取这样的名字。
n  // 单个字母 n 没有说明这是数量、下标还是错误码，作用域超过几行时不能再用这种名字。
nErr  // nErr 和 nCompConns 把多个单词压成几个字母，项目外的读者无法还原原来的词。
nCompConns  // nErr 和 nCompConns 把多个单词压成几个字母，项目外的读者无法还原原来的词。
wgcConnections  // wgcConnections 里的 wgc 只有当前小组知道含义，不能出现在别的模块还要阅读的名字里。
pcReader  // pc 可以是很多词的缩写，pcReader 没有告诉读者读的是哪一种设备或格式。
cstmrId  // cstmrId 删掉了 customer 中间的字母，搜索 customer 时找不到这个名字。
kSecondsPerDay  // kSecondsPerDay 用前缀表示种类，类型信息应留在类型系统里，不要写进名字。
customerID  // customerID 把标识写成了两个大写字母，驼峰里的缩写应写成 Id，而不是 ID。

```

#### Camel case

Treat abbreviations like acronyms in names as whole words, i.e. use `loadHttpUrl`, not 

`loadHTTPURL`

, unless required by a platform name (e.g. `XMLHttpRequest`).

#### Dollar sign

Identifiers should not generally use `$`, except when required by naming conventions for third party frameworks. See above for more on using `$` with `Observable` values.

### Rules by identifier type

Most identifier names should follow the casing in the table below, based on the identifier’s type.

| Style | Category |
| --- | --- |
| `UpperCamelCase` | class / interface / type / enum / decorator / type parameters / component functions in TSX / JSXElement type parameter |
| `lowerCamelCase` | variable / parameter / function / method / property / module alias |
| `CONSTANT_CASE` | global constant values, including enum values. See Constants below. |
| `#ident` | private identifiers are never used. |

#### Type parameters

Type parameters, like in `Array<T>`, may use a single upper case character (`T`) or `UpperCamelCase`.

#### Test names

Test method names inxUnit-style test frameworks may be structured with `_` separators, e.g. `testX_whenY_doesZ()`.

#### Underscore (`_`) prefix/suffix

An underscore prefix indicates a syntactically-required identifier will not be used. It is encouraged to provide a meaningful name after the underscore, but a standalone `_` is allowed.

```
(_projectId, api) => of(!params.disabledApis.includes(api));

[].filter((_, i) => i % 2 === 0);

for await (const _item of getAllTheThings()) {
    count++;
}

using _cleanupFoo = foo();

```

Do not use this style for trailing unused parameters, those should be omitted.

Trailing unused parameters are allowed on methods that are specifically intended to be overridden.

```
[].filter((element, _index) => !element.hasSomeProperty());

```

```
[].filter(element => !element.hasSomeProperty());

```

Identifiers must not use `_` as a suffix.

> Tip: If you only need some of the elements from an array (or TypeScript tuple), you can insert extra commas in a destructuring statement to ignore in-between elements:
> 
> ```
> const [a, , b] = [1, 5, 10]; // a <- 1, b <- 10
> 
> ```

#### Imports

Module namespace imports are `lowerCamelCase` while files are `snake_case`, which means that imports correctly will not match in casing style, such as

```
import * as fooBar from "./foo_bar";

```

Some libraries might commonly use a namespace import prefix that violates this naming scheme, but overbearingly common open source use makes the violating style more readable. The only libraries that currently fall under this exception are:

- jquery, using the `$` prefix
- threejs, using the `THREE` prefix

#### Constants

Immutable: `CONSTANT_CASE` indicates that a value is intended to not be changed, and may be used for values that can technically be modified (i.e. values that are not deeply frozen) to indicate to users that they must not be modified.

```
const UNIT_SUFFIXES = {
    "milliseconds": "ms",
    "seconds": "s",
};
// JavaScript 里这个对象仍然可以改，全大写是在告诉调用方不要修改单位后缀表。

```

A constant can also be a `static readonly` property of a class.

```
class Foo {
    private static readonly MY_SPECIAL_NUMBER = 5;

    bar() {
        return 2 * Foo.MY_SPECIAL_NUMBER;
    }
}

```

Global: Only symbols declared on the module level, static fields of module level classes, and values of module level enums, may use `CONST_CASE`. If a value can be instantiated more than once over the lifetime of the program (e.g. a local variable declared within a function, or a static field on a class nested in a function) then it must use `lowerCamelCase`. Local-scope aliases are excepted and should use the format of the existing identifier.

If a value is an arrow function that implements an interface, then it may be declared `lowerCamelCase`.

#### Aliases

When creating a local-scope alias of an existing symbol, use the format of the existing identifier. The local alias must match the existing naming and format of the source. For variables use `const` for your local aliases, and for class fields use the `readonly` attribute.

> Note: If you’re creating an alias just to expose it to a template in your framework of choice, remember to also apply the proper access modifiers.

```
const {BrewStateEnum} = SomeType;
const CAPACITY = 5;

class Teapot {
    readonly BrewStateEnum = BrewStateEnum;
    readonly CAPACITY = CAPACITY;
}

```

#### Overridden and implemented members

Properties and methods that override, implement, or narrow a base class or interface member, or appear in a contextually typed object literal, must match the existing declaration’s name and casing to compile. Casing rules therefore apply only at a member’s original declaration, which must follow them unless an external contract requires otherwise. Consider fixing the original declaration’s name if possible.

```
interface ServerResponse {
    // 属性名不要用下划线。error_code 应写成 errorCode，常量才使用 CONSTANT_CASE。
    error_code: number;
}

```

```
// 名字必须跟着外部契约走时，只在最初的声明上抑制命名检查，并写明为什么不能改成驼峰。
declare interface ServerResponse {
    // 这个字段必须叫 error_code 才能对上外部契约，所以只抑制下一行的命名检查，并把原因写在指令上面。
    // tslint:disable-next-line:enforce-name-casing
    error_code: number;
}

// 扩展或实现已经声明过的契约时，可以沿用它的下划线字段，不必在子类上再抑制一次命名检查。
interface ErrorResponse extends ServerResponse {
    error_code: 400 | 500;
}

```

## Type system

### Type inference

Code may rely on type inference as implemented by the TypeScript compiler for all type expressions (variables, fields, return types, etc).

```
const x = 15;  // 局部变量的类型可以从 15 推断出来，不必在左侧再写一遍 number，注解在这里是重复的。

```

Leave out type annotations when types are trivially inferred: unexported variables or parameters initialized to a `string`, `number`, or `boolean` literal. Type annotations are not considered trivial on exported symbols where required to be compatible with `isolatedDeclarations`.

```
let count: number = 0;  // 反例在能推断出 number 的局部变量上又写了类型，这种重复注解应删掉，推断结果已经够用。

// 反例导出的模板字符串没有显式类型，隔离声明生成不了这个常量的类型，导出时会失败。
export const PATH = `/users/${id}`;

```

```
let count = 0;

// 正例给导出的常量写上 string，隔离声明可以不看初始值就发出类型，模板怎么拼不影响声明。
export const PATH: string = `/users/${id}`;

```

Also leave out explicit generic types where they are redundant with the type annotation.

```
// 反例在变量和构造函数上各写了一次 string，构造函数的类型参数已经够用，左侧不必再写。
const x: Set<string> = new Set<string>();

```

```
const x = new Set<string>();  // 局部变量优先让构造函数的类型参数推断元素类型，不必在左侧再写 Set<string>。
// 导出的绑定需要显式类型，右侧可以省略类型参数，由左侧的 Set<string> 约束。
export const y: Set<string> = new Set();

```

For more complex expressions, type annotations can help with readability of the program:

```
// 这条远程调用经过 transform 之后，不看实现就说不出 value 的类型，应在左侧写上类型。
const value = await rpc.getSomeValue().transform();

```

```
// 左侧写成 string 数组之后，读者不用打开 transform 的实现也知道 value 里是什么。
const value: string[] = await rpc.getSomeValue().transform();

```

Whether an annotation is required is decided by the code reviewer.

#### Return types

Whether to include return type annotations for functions and methods is up to the code author. Reviewers may ask for annotations to clarify complex return types that are hard to understand. Projects may have a local policy to always require return types, but this is not a general TypeScript style requirement.

There are two benefits to explicitly typing out the implicit return values of functions and methods:

- More precise documentation to benefit readers of the code.
- Surface potential type errors faster in the future if there are code changes that change the return type of the function.

### Undefined and null

TypeScript supports `undefined` and `null` types. Nullable types can be constructed as a union type (`string|null`); similarly with `undefined`. There is no special syntax for unions of `undefined` and `null`.

TypeScript code can use either `undefined` or `null` to denote absence of a value, there is no general guidance to prefer one over the other. Many JavaScript APIs use `undefined` (e.g. `Map.get`), while many DOM and Google APIs use `null` (e.g. `Element.getAttribute`), so the appropriate absent value depends on the context.

#### Nullable/undefined type aliases

Type aliases must not include `|null` or `|undefined` in a union type. Nullable aliases typically indicate that null values are being passed around through too many layers of an application, and this clouds the source of the original issue that resulted in `null`. They also make it unclear when specific values on a class or interface might be absent.

Instead, code must only add `|null` or `|undefined` when the alias is actually used. Code should deal with null values close to where they arise, using the below techniques.

```
// 反例把 undefined 放进响应类型，每个调用点都要处理缺失，即使这个方法其实总会返回咖啡。
type CoffeeResponse = Latte|Americano|undefined;

class CoffeeService {
    getLatte(): CoffeeResponse { ... };
}

```

```
// 正例让返回类型在方法上写成可能缺失，类型别名本身只表示确实存在的咖啡种类，本例就是这样。
type CoffeeResponse = Latte|Americano;

class CoffeeService {
    getLatte(): CoffeeResponse|undefined { ... };
}

```

### Use structural types

TypeScript’s type system is structural, not nominal. That is, a value matches a type if it has at least all the properties the type requires and the properties’ types match, recursively.

When providing a structural-based implementation, explicitly include the type at the declaration of the symbol (this allows more precise type checking and error reporting).

```
const foo: Foo = {
    a: 123,
    b: "abc",
}

```

```
const badFoo = {
    a: 123,
    b: "abc",
}

```

Use interfaces to define structural types, not classes

```
interface Foo {
    a: number;
    b: string;
}

const foo: Foo = {
    a: 123,
    b: "abc",
}

```

```
class Foo {
    readonly a: number;
    readonly b: number;
}

const foo: Foo = {
    a: 123,
    b: "abc",
}

```

The “badFoo” object above relies on type inference. Additional fields could be added to “badFoo” and the type is inferred based on the object itself.

When passing a “badFoo” to a function that takes a “Foo”, the error will be at the function call site, rather than at the object declaration site. This is also useful when changing the surface of an interface across broad codebases.

```
interface Animal {
    sound: string;
    name: string;
}

function makeSound(animal: Animal) {}

/** cat 只写了 sound，推断出来的类型没有 name，它还不是 Animal。 */
const cat = {
    sound: "meow",
};

/** cat 不满足 Animal 的契约，错误报在这次调用上，可能离 cat 的定义很远。 */
makeSound(cat);

/** horse 被显式标成 Animal，缺 name 的错误出现在定义处，而不是后面的函数调用。 */
const horse: Animal = {
    sound: "niegh",
};

const dog: Animal = {
    sound: "bark",
    name: "MrPickles",
};

makeSound(dog);
makeSound(horse);

```

### Prefer interfaces over type literal aliases

TypeScript supports type aliases for naming a type expression. This can be used to name primitives, unions, tuples, and any other types.

However, when declaring types for objects, use interfaces instead of a type alias for the object literal expression.

```
interface User {
    firstName: string;
    lastName: string;
}

```

```
type User = {
    firstName: string,
    lastName: string,
}

```

Why?

These forms are nearly equivalent, so under the principle of just choosing one out of two forms to prevent variation, we should choose one. Additionally, there are also interesting technical reasons to prefer interface. That page quotes the TypeScript team lead: “Honestly, my take is that it should really just be interfaces for anything that they can model. There is no benefit to type aliases when there are so many issues around display/perf.”

### `Array<T>` Type

For simple types (containing just alphanumeric characters and dot), use the syntax sugar for arrays, `T[]` or `readonly T[]`, rather than the longer form `Array<T>` or `ReadonlyArray<T>`.

For multi-dimensional non-`readonly` arrays of simple types, use the syntax sugar form (`T[][]`, `T[][][]`, and so on) rather than the longer form.

For anything more complex, use the longer form `Array<T>`.

These rules apply at each level of nesting, i.e. a simple `T[]` nested in a more complex type would still be spelled as `T[]`, using the syntax sugar.

```
let a: string[];
let b: readonly string[];
let c: ns.MyObj[];
let d: string[][];
let e: Array<{n: number, s: string}>;
let f: Array<string|number>;
let g: ReadonlyArray<string|number>;
let h: InjectionToken<string[]>;  // 内层已经是数组时仍用 T[] 这种写法，不要再套一层 Array，阅读嵌套类型时更短。
let i: ReadonlyArray<string[]>;
let j: Array<readonly string[]>;

```

```
let a: Array<string>;  // 元素类型只是 string 时，string[] 比 Array<string> 短，应使用方括号形式。
let b: ReadonlyArray<string>;
let c: Array<ns.MyObj>;
let d: Array<string[]>;
let e: {n: number, s: string}[];  // 对象类型外面再套方括号，花括号和方括号叠在一起，不如 Array<对象> 清楚。
let f: (string|number)[];  // 联合类型外面再套括号和方括号同样难读，这种情况用 Array 包住联合，比叠括号更清楚。
let g: readonly (string | number)[];
let h: InjectionToken<Array<string>>;
let i: readonly string[][];
let j: (readonly string[])[];

```

### Indexable types / index signatures (`{[key: string]: T}`)

In JavaScript, it’s common to use an object as an associative array (aka “map”, “hash”, or “dict”). Such objects can be typed using an index signature (`[k: string]: T`) in TypeScript:

```
const fileSizes: {[fileName: string]: number} = {};
fileSizes["readme.txt"] = 541;

```

In TypeScript, provide a meaningful label for the key. (The label only exists for documentation; it’s unused otherwise.)

```
const users: {[key: string]: number} = ...;

```

```
const users: {[userName: string]: number} = ...;

```

> Rather than using one of these, consider using the ES6 `Map` and `Set` types instead. JavaScript objects have surprising undesirable behaviors and the ES6 types more explicitly convey your intent. Also, `Map` s can be keyed by—and `Set` s can contain—types other than `string`.

TypeScript’s built-in `Record<Keys, ValueType>` type allows constructing types with a defined set of keys. This is distinct from associative arrays in that the keys are statically known. See advice on that below.

### Mapped and conditional types

TypeScript’s mapped types and conditional types allow specifying new types based on other types. TypeScript’s standard library includes several type operators based on these (`Record`, `Partial`, `Readonly` etc).

These type system features allow succinctly specifying types and constructing powerful yet type safe abstractions. They come with a number of drawbacks though:

- Compared to explicitly specifying properties and type relations (e.g. using interfaces and extension, see below for an example), type operators require the reader to mentally evaluate the type expression. This can make programs substantially harder to read, in particular combined with type inference and expressions crossing file boundaries.
- Mapped & conditional types’ evaluation model, in particular when combined with type inference, is underspecified, not always well understood, and often subject to change in TypeScript compiler versions. Code can “accidentally” compile or seem to give the right results. This increases future support cost of code using type operators.
- Mapped & conditional types are most powerful when deriving types from complex and/or inferred types. On the flip side, this is also when they are most prone to create hard to understand and maintain programs.
- Some language tooling does not work well with these type system features. E.g. your IDE’s find references (and thus rename property refactoring) will not find properties in a `Pick<T, Keys>` type, and Code Search won’t hyperlink them. *

The style recommendation is:

- Always use the simplest type construct that can possibly express your code.
- A little bit of repetition or verbosity is often much cheaper than the long term cost of complex type expressions.
- Mapped & conditional types may be used, subject to these considerations.

For example, TypeScript’s built-in `Pick<T, Keys>` type allows creating a new type by subsetting another type `T`, but simple interface extension can often be easier to understand.

```
interface User {
    shoeSize: number;
    favoriteIcecream: string;
    favoriteChocolate: string;
}

// FoodPreferences 只挑选两种食物字段，不包含 shoeSize，调用方不能从中读到鞋码。
type FoodPreferences = Pick<User, "favoriteIcecream"|"favoriteChocolate">;

```

This is equivalent to spelling out the properties on `FoodPreferences`:

```
interface FoodPreferences {
    favoriteIcecream: string;
    favoriteChocolate: string;
}

```

To reduce duplication, `User` could extend `FoodPreferences`, or (possibly better) nest a field for food preferences:

```
// 这里的 FoodPreferences 与上面选出的两种食物字段相同，示例不再把字段重复写一遍。
interface FoodPreferences { }
interface User extends FoodPreferences {
    shoeSize: number;
    // User 扩展了食物偏好，因此除了鞋码还包含冰淇淋和巧克力这两个字段，调用方能直接读取。
}

```

Using interfaces here makes the grouping of properties explicit, improves IDE support, allows better optimization, and arguably makes the code easier to understand.

### `any` Type

TypeScript’s `any` type is a super and subtype of all other types, and allows dereferencing all properties. As such, `any` is dangerous - it can mask severe programming errors, and its use undermines the value of having static types in the first place.

Consider not to use `any`. In circumstances where you want to use `any`, consider one of:

- Provide a more specific type
- Use `unknown`
- Suppress the lint warning and document why

#### Providing a more specific type

Use interfaces , an inline object type, or a type alias:

```
// 服务端 JSON 用声明合并的接口描述，后来加上的字段可以补在另一个同名声明里。
declare interface MyUserJson {
    name: string;
    email: string;
}

// 重复出现的联合可以用类型别名命名。这里的别名不是对象字面量，不必改成接口，本例就是这样。
type MyType = number|string;

// 只在这一处返回的对象可以写在返回类型里，不必为了这一次返回再去声明一个接口，本例就是这样。
function getTwoThings(): {something: number, other: string} {
    // 这里省掉了和本条规则无关的语句，读者只需要看留下的那几行就能判断写法是否符合要求。
    return {something, other};
}

// 库函数不关心元素的具体类型时用类型参数，不要写成 any，调用方才能把元素类型带回去。
function nicestElement<T>(items: T[]): T {
    // 函数体在这些元素里选出最合适的一个。需要限制元素种类时，把约束写在 T 上，例如要求它是 HTMLElement。
}

```

#### Using `unknown` over `any`

The `any` type allows assignment into any other type and dereferencing any property off it. Often this behaviour is not necessary or desirable, and code just needs to express that a type is unknown. Use the built-in type `unknown` in that situation — it expresses the concept and is much safer as it does not allow dereferencing arbitrary properties.

```
// unknown 可以接住任何值，包括 null 和 undefined，但在收窄或断言之前不能读取它的属性。
const val: unknown = value;

```

```
// 这个值来自任意表达式，示例用 any 接住它，用来对照后面那次未经检查的属性访问。
const danger: any = value;
danger.whoops();  // 通过 any 读取 whoops 不会做任何检查，拼写错误也会安静地变成运行时失败。

```

To safely use `unknown` values, narrow the type using a type guard

#### Suppressing `any` lint warnings

Sometimes using `any` is legitimate, for example in tests to construct a mock object. In such cases, add a comment that suppresses the lint warning, and document why it is legitimate.

```
// 这个测试只需要 BookService 的一部分。缺方法时测试会明显失败，所以这里有意做成不安全的部分替身。
// tslint:disable-next-line:no-any
const mockBookService = ({get() { return mockBook; }} as any) as BookService;
// 这个测试不会触碰购物车，用 any 占住构造参数只是为了满足签名，不代表购物车可以被随便替换。
// tslint:disable-next-line:no-any
// 购物车参数在这个测试里不会被读取，保留空值只是为了把构造函数的参数位置填上，本例就是这样。
const component = new MyComponent(mockBookService, null as any);

```

### `{}` Type

The `{}` type, also known as an empty interface type, represents an interface with no properties. An empty interface type has no specified properties and therefore any non-nullish value is assignable to it.

```
let player: {};

player = {
    health: 50,
};  // 把任意对象赋给空对象类型是允许的，空对象类型几乎不限制赋值来源，读取属性时才会被拒绝。

console.log(player.health)  // 空对象类型上不存在 health。赋值阶段放过的属性，在读取时会被编译器拒绝，本例就是这样。

```

```
function takeAnything(obj:{}) {

}

takeAnything({});
takeAnything({ a: 1, b: 2 });

```

Google3 code should not use `{}` for most use cases. `{}` represents any non-nullish primitive or object type, which is rarely appropriate. Prefer one of the following more-descriptive types:

- `unknown` can hold any value, including `null` or `undefined`, and is generally more appropriate for opaque values.
- `Record<string, T>` is better for dictionary-like objects, and provides better type safety by being explicit about the type `T` of contained values (which may itself be `unknown`).
- `object` excludes primitives as well, leaving only non-nullish functions and objects, but without any other assumptions about what properties may be available.

### Tuple types

If you are tempted to create a Pair type, instead use a tuple type:

```
interface Pair {
    first: string;
    second: string;
}
function splitInHalf(input: string): Pair {
    ...
    return {first: x, second: y};
}

```

```
function splitInHalf(input: string): [string, string] {
    ...
    return [x, y];
}

// 调用方按元组的位置拆开返回值，左边是前半段，右边是后半段，顺序必须和声明一致，本例就是这样。
const [leftHalf, rightHalf] = splitInHalf("my string");

```

However, often it’s clearer to provide meaningful names for the properties.

If declaring an `interface` is too heavyweight, you can use an inline object literal type:

```
function splitHostPort(address: string): {host: string, port: number} {
    ...
}

// 调用方按元组的位置拆开返回值，左边是前半段，右边是后半段，顺序必须和声明一致，本例就是这样。
const address = splitHostPort(userAddress);
use(address.port);

// 也可以按字段名解构主机和端口，效果接近元组，但调用方不用记住两个位置谁先谁后，本例就是这样。
const {host, port} = splitHostPort(userAddress);

```

### Wrapper types

There are a few types related to JavaScript primitives that should not ever be used:

- `String`, `Boolean`, and `Number` have slightly different meaning from the corresponding primitive types `string`, `boolean`, and `number`. Always use the lowercase version.
- `Object` has similarities to both `{}` and `object`, but is slightly looser. Use `{}` for a type that include everything except `null` and `undefined`, or lowercase `object` to further exclude the other primitive types (the three mentioned above, plus `symbol` and `bigint`).

Further, never invoke the wrapper types as constructors (with `new`).

### Return type only generics

Avoid creating APIs that have return type only generics. When working with existing APIs that have return type only generics always explicitly specify the generics.

## Toolchain requirements

Google style requires using a number of tools in specific ways, outlined here.

### TypeScript compiler

All TypeScript files must pass type checking using the standard tool chain.

#### @ts-ignore

Do not use `@ts-ignore` nor the variants `@ts-expect-error` or `@ts-nocheck`.

Why?

They superficially seem to be an easy way to “fix” a compiler error, but in practice, a specific compiler error is often caused by a larger problem that can be fixed more directly.

For example, if you are using `@ts-ignore` to suppress a type error, then it’s hard to predict what types the surrounding code will end up seeing. For many type errors, the advice in how to best use `any` is useful.

You may use `@ts-expect-error` in unit tests, though you generally should not. `@ts-expect-error` suppresses all errors. It’s easy to accidentally over-match and suppress more serious errors. Consider one of:

- When testing APIs that need to deal with unchecked values at runtime, add casts to the expected type or to `any` and add an explanatory comment. This limits error suppression to a single expression.
- Suppress the lint warning and document why, similar to suppressing `any` lint warnings.

### Conformance

Google TypeScript includes several conformance frameworks, tsetse and tsec.

These rules are commonly used to enforce critical restrictions (such as defining globals, which could break the codebase) and security patterns (such as using `eval` or assigning to `innerHTML`), or more loosely to improve code quality.

Google-style TypeScript must abide by any applicable global or framework-local conformance rules.

## Comments and documentation

#### JSDoc versus comments

There are two types of comments, JSDoc (`/** ... */`) and non-JSDoc ordinary comments (`// ...` or `/* ... */`).

- Use `/** JSDoc */` comments for documentation, i.e. comments a user of the code should read.
- Use `// line comments` for implementation comments, i.e. comments that only concern the implementation of the code itself.
- Write every comment in Chinese. The product name VeriQ and technical identifiers may stay as written.
- The first line of a comment block has at least 40 characters of comment text. Each comment line has at most 80 characters; wrap the rest.

JSDoc comments are understood by tools (such as editors and documentation generators), while ordinary comments are only for other humans.

#### Multi-line comments

Multi-line comments are indented at the same level as the surrounding code. They must use multiple single-line comments (`//`-style), not block comment style (`/* */`).

```
// 多行实现注释用连续的双斜线，每行单独成注释，不要改成会把说明包成一块的块注释，本例就是这样。

```

```
/** 反例用块注释包了多行实现说明，这种说明必须改成连续的双斜线，不能留在块注释里，本例就是这样。 */

/** 反例用单行块注释写实现说明。这种说明应使用双斜线，块注释不是实现注释的形式，本例就是这样。 */

```

Comments are not enclosed in boxes drawn with asterisks or other characters.

### JSDoc general form

The basic formatting of JSDoc comments is as seen in this example:

```
/**
 * 多行文档按普通句子换行，参数标签各自独占一行，不要把说明和标签挤在同一行里，本例就是这样。
 * @param arg 交给函数处理的数字，调用方要保证它是有限数值。
 */
function doSomething(arg: number) { … }

```

or in this single-line example:

```
/** 这个函数按参数完成一次转换，文档要说明转换结果交给谁，而不是只把函数名再说一遍。 */
function doSomething(arg: number) { … }

```

If a single-line comment overflows into multiple lines, it must use the multi-line style with `/**` and `*/` on their own lines.

Many tools extract metadata from JSDoc comments to perform code validation and optimization. As such, these comments must be well-formed.

### Markdown

JSDoc is written in Markdown, though it may include HTML when necessary.

This means that tooling parsing JSDoc will ignore plain text formatting, so if you did this:

```
/**
 * 重量由三项因素一起决定。纯文本换行会被文档工具拼成一段，读者看不到原来的分行，本例就是这样。
 * 发出的件数
 * 收到的件数
 * 最后一次的时间戳
 */

```

it will be rendered like this:

```
Computes weight based on three factors: items sent items received last timestamp

```

Instead, write a Markdown list:

```
/**
 * 重量由下面三项一起决定，列表必须写成 Markdown，文档工具才会保留项目符号。
 *
 * - 发出的件数
 * - 收到的件数
 * - 最后一次的时间戳
 */

```

### JSDoc tags

Google style allows a subset of JSDoc tags. Most tags must occupy their own line, with the tag at the beginning of the line.

```
/**
 * 参数标签必须各自独占一行，不能把两个 @param 写在同一行，解析器无法拆开两段说明。
 * @param left 加法的左操作数，调用方传入已经对齐单位的数字。
 * @param right 加法的右操作数，单位必须和左操作数相同。
 */
function add(left: number, right: number) { ... }

```

```
/**
 * 反例把左右参数的标签写在同一行，解析器无法分开两段说明，两个参数的契约都丢失了。
 * @param left @param right
 */
function add(left: number, right: number) { ... }

```

### Line wrapping

Line-wrapped block tags are indented four spaces. Wrapped description text may be lined up with the description on previous lines, but this horizontal alignment is discouraged.

```
/**
 * 这一段演示参数和返回说明过长时如何换行，续行不要再和上一行的行尾做水平对齐，本例就是这样。
 * @param foo 这个参数的说明超过一行，换行后的文字放在下一行，并相对标签缩进四个空格。
 * @return 返回值的说明同样可能超过一行，续行遵循同一缩进，不要和上一行的文字尾部对齐。
 */
exports.method = function(foo) {
    return 5;
};

```

Do not indent when wrapping a `@desc` or `@fileoverview` description.

### Document all top-level exports of modules

Use `/** JSDoc */` comments to communicate information to the users of your code. Avoid merely restating the property or parameter name. You should also document all properties and methods (exported/public or not) whose purpose is not immediately obvious from their name, as judged by your reviewer.

Exception: Symbols that are only exported to be consumed by tooling, such as @NgModule classes, do not require comments.

### Class comments

JSDoc comments for classes should provide the reader with enough information to know how and when to use the class, as well as any additional considerations necessary to correctly use the class. Textual descriptions may be omitted on the constructor.

### Method and function comments

Method, parameter, and return descriptions may be omitted if they are obvious from the rest of the method’s JSDoc or from the method name and type signature.

Method descriptions are written in Chinese. The first line of the comment block has at least 40 characters, and each comment line has at most 80 characters. Describe what the method does; do not copy an English “This method …” prefix.

### Parameter property comments

A parameter property is a constructor parameter that is prefixed by one of the modifiers `private`, `protected`, `public`, or `readonly`. A parameter property declares both a parameter and an instance property, and implicitly assigns into it. For example, `constructor(private readonly foo: Foo)`, declares that the constructor takes a parameter `foo`, but also declares a private readonly property `foo`, and assigns the parameter into that property before executing the remainder of the constructor.

To document these fields, use JSDoc’s `@param` annotation. Editors display the description on constructor calls and property accesses.

```
/** 这个类演示参数属性的文档写在构造函数的参数标签上，而不是写在类体里的字段旁边，本例就是这样。 */
class ParamProps {
    /**
     * 参数属性同时声明构造参数和实例字段，说明写在对应的参数标签上，字段旁不再重复，本例就是这样。
     * @param percolator 用来冲煮的渗滤壶，构造之后仍可通过同名字段读取。
     * @param beans 这次要冲煮的咖啡豆，构造函数会把它保存为实例字段。
     */
    constructor(
        private readonly percolator: Percolator,
        private readonly beans: CoffeeBean[]) {}
}

```

```
/** 这个类演示普通字段的文档直接写在字段上方，而不是写进构造函数的参数列表里，本例就是这样。 */
class OrdinaryClass {
    /** 下一次调用 brew 时会使用的咖啡豆。替换这个字段，就会改变下一次冲煮所用的原料。 */
    nextBean: CoffeeBean;

    constructor(initialBean: CoffeeBean) {
        this.nextBean = initialBean;
    }
}

```

### JSDoc type annotations

JSDoc type annotations are redundant in TypeScript source code. Do not declare types in `@param` or `@return` blocks, do not write `@implements`, `@enum`, `@private`, `@override` etc. on code that uses the `implements`, `enum`, `private`, `override` etc. keywords.

### Make comments that actually add information

For non-exported symbols, sometimes the name and type of the function or parameter is enough. Code will usually benefit from more documentation than just variable names though!

- Avoid comments that just restate the parameter name and type, e.g.

```
/** 反例只是把参数名 fooBarService 再说成 Foo 应用的 Bar 服务，没有增加调用方还不知道的信息。 */

```
- Because of this rule, `@param` and `@return` lines are only required when they add information, and may otherwise be omitted.

```
/**
 * 向冲煮服务发送启动请求，并按升数准备这一壶咖啡，调用方传入的升数不能超过壶的容量。
 * @param amountLitres 本次冲煮的升数，必须能装进当前壶的容量，超出时调用方要先减少用量。
 */
brew(amountLitres: number, logger: Logger) {
    // 这里省掉了和本条规则无关的语句，读者只需要看留下的那几行就能判断写法是否符合要求。
}

```

#### Comments when calling a function

“Parameter name” comments should be used whenever the method name and parameter value do not sufficiently convey the meaning of the parameter.

Before adding these comments, consider refactoring the method to instead accept an interface and destructure it to greatly improve call-site readability.

“Parameter name” comments go before the parameter value, and include the parameter name and a `=` suffix:

```
// 调用点在值前面或值后面重复参数名，因为只看 true 和字符串看不出它们对应 shouldRender 还是 name。
someFunction(obviousParam, /* shouldRender= */ true, /* name= */ "hello");

```

Existing code may use a legacy parameter name comment style, which places these comments ~after~ the parameter value and omits the `=`. Continuing to use this style within the file for consistency is acceptable.

```
// 调用点在值前面或值后面重复参数名，因为只看 true 和字符串看不出它们对应 shouldRender 还是 name。
someFunction(obviousParam, true /* shouldRender */, "hello" /* name */);

```

### Place documentation prior to decorators

When a class, method, or property have both decorators like `@Component` and JsDoc, please make sure to write the JsDoc before the decorator.

- Do not write JsDoc between the Decorator and the decorated statement.

```
@Component({
    selector: "foo",
    template: "bar",
})
/** 这个组件把模板里的 bar 渲染出来，文档要放在装饰器之前，编辑器才能在选择器旁显示说明。 */
export class FooComponent {}

```
- Write the JsDoc block before the Decorator.

```
/** 这个组件把模板里的 bar 渲染出来，文档要放在装饰器之前，编辑器才能在选择器旁显示说明。 */
@Component({
    selector: "foo",
    template: "bar",
})
export class FooComponent {}

```

## Policies

### Consistency

For any style question that isn’t settled definitively by this specification, do what the other code in the same file is already doing (“be consistent”). If that doesn’t resolve the question, consider emulating the other files in the same directory.

Brand new files must use Google Style, regardless of the style choices of other files in the same package. When adding new code to a file that is not in Google Style, reformatting the existing code first is recommended, subject to the advice below. If this reformatting is not done, then new code should be as consistent as possible with existing code in the same file, but must not violate the style guide.

#### Reformatting existing code

You will occasionally encounter files in the codebase that are not in proper Google Style. These may have come from an acquisition, or may have been written before Google Style took a position on some issue, or may be in non-Google Style for any other reason.

When updating the style of existing code, follow these guidelines.

1. It is not required to change all existing code to meet current style guidelines. Reformatting existing code is a trade-off between code churn and consistency. Style rules evolve over time and these kinds of tweaks to maintain compliance would create unnecessary churn. However, if significant changes are being made to a file it is expected that the file will be in Google Style.
2. Be careful not to allow opportunistic style fixes to muddle the focus of a CL. If you find yourself making a lot of style changes that aren’t critical to the central focus of a CL, promote those changes to a separate CL.

### Deprecation

Mark deprecated methods, classes or interfaces with an `@deprecated` JSDoc annotation. A deprecation comment must include simple, clear directions for people to fix their call sites.

### Generated code: mostly exempt

Source code generated by the build process is not required to be in Google Style. However, any generated identifiers that will be referenced from hand-written source code must follow the naming requirements. As a special exception, such identifiers are allowed to contain underscores, which may help to avoid conflicts with hand-written identifiers.

#### Style guide goals

In general, engineers usually know best about what’s needed in their code, so if there are multiple options and the choice is situation dependent, we should let decisions be made locally. So the default answer should be “leave it out”.

The following points are the exceptions, which are the reasons we have some global rules. Evaluate your style guide proposal against the following:

1. Code should avoid patterns that are known to cause problems, especially for users new to the language.
2. Code across projects should be consistent across irrelevant variations.

When there are two options that are equivalent in a superficial way, we should consider choosing one just so we don’t divergently evolve for no reason and avoid pointless debates in code reviews.

Examples:

- The capitalization style of names.
- `x as T` syntax vs the equivalent ` x` syntax (disallowed).
- `Array<[number, number]>` vs `[number, number][]`.
3. Code should be maintainable in the long term.

Code usually lives longer than the original author works on it, and the TypeScript team must keep all of Google working into the future.

Examples:

- We use software to automate changes to code, so code is autoformatted so it’s easy for software to meet whitespace rules.
- We require a single set of compiler flags, so a given TS library can be written assuming a specific set of flags, and users can always safely use a shared library.
- Code must import the libraries it uses (“strict deps”) so that a refactor in a dependency doesn’t change the dependencies of its users.
- We ask users to write tests. Without tests we cannot have confidence that changes that we make to the language, don’t break users.
4. Code reviewers should be focused on improving the quality of the code, not enforcing arbitrary rules.

If it’s possible to implement your rule as an automated check that is often a good sign. This also supports principle 3.

If it really just doesn’t matter that much – if it’s an obscure corner of the language or if it avoids a bug that is unlikely to occur – it’s probably worth leaving out.

1. Namespace imports are often called ‘module imports’ ↩
2. named imports are sometimes called ‘destructuring imports’ because they use similar syntax to destructuring assignments. ↩
