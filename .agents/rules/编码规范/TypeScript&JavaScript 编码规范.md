# TypeScript&JavaScript 编码规范

来源：[https://google.github.io/styleguide/tsguide.html](https://google.github.io/styleguide/tsguide.html)

改编：缩进由 Google 惯用 2 空格改为 4 空格；禁止 Tab

用途：约束 AI/人工编写 TypeScript/JavaScript

## 引言

### 术语说明

本风格指南在使用 must、must not、should、should not、may 等用语时遵循 RFC 2119 术语。prefer 与 avoid 分别对应 should 与 should not。祈使句与陈述句具有规范性，对应 must（必须）。

### 指南说明

所有示例均为非规范性内容，仅用于说明风格指南的规范性表述。也就是说，尽管示例符合 Google 风格，它们未必是呈现代码的唯一得体方式。示例中的可选格式选择禁止作为规则强制执行。

## 缩进与格式化约定（本改编版强制）

> **改编说明**：Google 官方 TypeScript/JS 风格示例与内部 clang-format Google 风格默认使用 **2 空格**缩进。本文件将所有缩进相关要求统一改为 **4 个空格**，禁止使用 Tab。其余规则保留原文语义。

### 块缩进

- 必须使用 **4 个空格**作为一个缩进级别。
- 禁止使用 Tab 字符。
- 嵌套块每层增加 4 个空格。
- 续行可采用与开分隔符对齐，或使用悬挂缩进（相对语句起始再缩进 4 个空格）。



### 列宽与空白

- 其余空白、分号、大括号等格式约定仍遵循本文其余章节；示例代码均已按 4 空格缩进展示。



## 源文件基础



### 文件编码：UTF-8

源文件使用 UTF-8 编码。

#### 空白字符

除换行符序列外，ASCII 水平空格字符（0x20）是源文件中唯一允许出现的空白字符。这意味着字符串字面量中的所有其他空白字符都必须转义。

#### 特殊转义序列

对于具有特殊转义序列的任何字符（`\'`、`\"`、`\\` 、`\b`、`\f`、`\n`、`\r`、`\t`、`\v`），使用该序列，而不是对应的数值转义（例如 `\x0a`、`\u000a` 或 `\u{a}`）。禁止使用遗留的八进制转义。

#### 非 ASCII 字符

对其余非 ASCII 字符，使用实际的 Unicode 字符（例如 `∞`）。对于不可打印字符，可以使用等价的十六进制或 Unicode 转义（例如 `\u221e`），并附上说明性注释。

```
// Perfectly clear, even without a comment.
const units = 'μs';

// Use escapes for non-printable characters.
const output = '\ufeff' + content;  // byte order mark

```

```
// Hard to read and prone to mistakes, even with the comment.
const units = '\u03bcs'; // Greek letter mu, 's'

// The reader has no idea what this is.
const output = '\ufeff' + content;

```



## 源文件结构

文件按以下顺序组成：

1. 版权信息（若有）
2. 含 `@fileoverview` 和/或其他文件级 JSDoc 标签的 JSDoc（若有）
3. 导入（若有）
4. 文件的实现内容

各已存在的部分之间恰好用一个空行分隔。

### 版权信息

若文件需要许可证或版权信息，将其放在文件顶部的 JSDoc 中。

### `@fileoverview` JSDoc

文件可以有顶层 `@fileoverview` JSDoc。若存在，可以提供文件内容、用途或其依赖相关信息。换行后的行不缩进。

示例：

```
/**
 * @fileoverview Description of file. Lorem ipsum dolor sit amet, consectetur
 * adipiscing elit, sed do eiusmod tempor incididunt.
 */

```



### 导入

ES6 与 TypeScript 中有四种导入语句变体：


| 导入类型        | 示例                               | 用途                       |
| ----------- | -------------------------------- | ------------------------ |
| module 1    | `import * as foo from '...';`    | TypeScript 导入            |
| named 2     | `import {SomeThing} from '...';` | TypeScript 导入            |
| default     | `import SomeThing from '...';`   | 仅用于要求默认导入的其他外部代码         |
| side-effect | `import '...';`                  | 仅用于导入在加载时产生副作用的库（如自定义元素） |


```
// Good: choose between two options as appropriate (see below).
import * as ng from '@angular/core';
import {Foo} from './foo';

// Only when needed: default imports.
import Button from 'Button';

// Sometimes needed to import libraries for their side effects:
import 'jasmine';
import '@polymer/paper-button';

```



#### 导入路径

TypeScript 代码必须使用路径导入其他 TypeScript 代码。路径可以是相对路径（即以 `.` 或 `..` 开头），或以基目录为根的路径，例如 `root/path/to/file`。

引用同一（逻辑）项目内的文件时，应当使用相对导入（`./foo`）而非绝对导入 `path/to/foo`，这样在移动项目时无需改动这些导入。

考虑限制父级路径步数（`../../../`），因为过多的上级路径会使模块与路径结构难以理解。

```
import {Symbol1} from 'path/from/root';
import {Symbol2} from '../parent/file';
import {Symbol3} from './sibling';

```



#### 命名空间导入与具名导入

命名空间导入与具名导入均可使用。

对文件中频繁使用的符号，或名称清晰的符号（例如 Jasmine 的 `describe` 与 `it`），优先使用具名导入。具名导入可按需用 `as` 起更清晰的别名。

从大型 API 使用许多不同符号时，优先使用命名空间导入。尽管使用了 `*` 字符，命名空间导入与其他语言中的“通配符”导入并不相同。命名空间导入会为模块的全部导出赋予一个名称，模块中每个导出符号成为该模块名上的属性。对于像 `Model` 或 `Controller` 这类常见名称的导出符号，命名空间导入有助于可读性，而无需声明别名。

```
// Bad: overlong import statement of needlessly namespaced names.
import {Item as TableviewItem, Header as TableviewHeader, Row as TableviewRow,
    Model as TableviewModel, Renderer as TableviewRenderer} from './tableview';

let item: TableviewItem|undefined;

```

```
// Better: use the module for namespacing.
import * as tableview from './tableview';

let item: tableview.Item|undefined;

```

```
import * as testing from './testing';

// Bad: The module name does not improve readability.
testing.describe('foo', () => {
    testing.it('bar', () => {
        testing.expect(null).toBeNull();
        testing.expect(undefined).toBeUndefined();
    });
});

```

```
// Better: give local names for these common functions.
import {describe, it, expect} from './testing';

describe('foo', () => {
    it('bar', () => {
        expect(null).toBeNull();
        expect(undefined).toBeUndefined();
    });
});

```



##### 特例：Apps JSPB protos

Apps JSPB protos 必须使用具名导入，即使会导致很长的导入行。

此规则有助于构建性能与死代码消除，因为 `.proto` 文件常包含许多 `message`，并不总是需要一并使用。通过解构导入，构建系统可以对 Apps JSPB 消息建立更细粒度的依赖，同时保留基于路径的导入体验。

```
// Good: import the exact set of symbols you need from the proto file.
import {Foo, Bar} from './foo.proto';

function copyFooBar(foo: Foo, bar: Bar) {...}

```



#### 重命名导入

代码应当通过命名空间导入或重命名导出本身来解决名称冲突。若有需要，代码可以重命名导入（`import {SomeThing as SomeOtherThing}`）。

重命名有用的三种情形：

1. 必须避免与其他已导入符号冲突时。
2. 导入的符号名是生成的时。
3. 导入的符号名本身不清晰时，重命名可提高代码清晰度。例如，使用 RxJS 时，将 `from` 重命名为 `observableFrom` 可能更易读。



### 导出

所有代码使用具名导出：

```
// Use named exports:
export class Foo { ... }

```

禁止使用默认导出。这确保所有导入遵循统一模式。

```
// Do not use default exports:
export default class Foo { ... } // BAD!

```

为什么？

默认导出没有规范名称，使集中维护困难，而对代码所有者收益相对有限，并可能降低可读性：

```
import Foo from './bar';  // Legal.
import Bar from './bar';  // Also legal.

```

具名导出的好处是：当导入语句试图导入未声明的内容时会报错。在 `foo.ts` 中：

```
const foo = 'blah';
export default foo;

```

而在 `bar.ts` 中：

```
import {fizz} from './foo';

```

结果为 `error TS2614: Module '"./foo"' has no exported member 'fizz'.`。而 `bar.ts`：

```
import fizz from './foo';

```

结果为 `fizz === foo`，这很可能出乎意料且难以调试。

此外，默认导出鼓励人们把一切放进一个大对象中做命名空间：

```
export default class Foo {
    static SOME_CONSTANT = ...
    static someHelpfulFunction() { ... }
    ...
}

```

上述模式中，我们已有文件作用域可用作命名空间。同时还可能有一个多余的第二作用域（类 `Foo`），在其他文件中既可作类型又可作值，产生歧义。

相反，优先使用文件作用域做命名空间，以及具名导出：

```
export const SOME_CONSTANT = ...
export function someHelpfulFunction()
export class Foo {
    // only class stuff here
}

```



#### 导出可见性

TypeScript 不支持限制导出符号的可见性。只导出在模块外使用的符号。总体上尽量缩小模块的导出 API 面。

#### 可变导出

无论技术上是否支持，可变导出都会造成难以理解与调试的代码，尤其是跨多个模块再导出时。用一句话说：不允许 `export let`。

```
export let foo = 3;
// In pure ES6, foo is mutable and importers will observe the value change after a second.
// In TS, if foo is re-exported by a second file, importers will not see the value change.
window.setTimeout(() => {
    foo = 4;
}, 1000 /* ms */);

```

若需要支持外部可访问且可变的绑定，应当改用显式 getter 函数。

```
let foo = 3;
window.setTimeout(() => {
    foo = 4;
}, 1000 /* ms */);
// Use an explicit getter to access the mutable export.
export function getFoo() { return foo; };

```

对于有条件地导出两个值之一的常见模式，先做条件检查，再导出。确保模块体执行完毕后所有导出都是最终值。

```
function pickApi() {
    if (useOtherApi()) return OtherApi;
    return RegularApi;
}
export const SomeApi = pickApi();

```



#### 容器类

禁止仅为命名空间而创建带有静态方法或属性的容器类。

```
export class Container {
    static FOO = 1;
    static bar() { return 1; }
}

```

改为分别导出常量和函数：

```
export const FOO = 1;
export function bar() { return 1; }

```



### 导入与导出类型



#### 导入类型

当仅将导入符号用作类型时，可以使用 `import type {...}`。值使用常规导入：

```
import type {Foo} from './foo';
import {Bar} from './foo';

import {type Foo, Bar} from './foo';

```

TypeScript 编译器会自动处理这一区分，不会为类型引用插入运行时加载。那为何还要标注类型导入？

TypeScript 编译器可在两种模式下运行：

- 开发模式下，通常希望快速迭代。编译器在无完整类型信息的情况下转译为 JavaScript。这快得多，但在某些情况下需要 `import type`。
- 生产模式下，需要正确性。编译器做完整类型检查并确保正确使用 `import type`。

注意：若需要强制运行时加载以产生副作用，使用 `import '...';`。参见导入一节。

#### 导出类型

再导出类型时使用 `export type`，例如：

```
export type {AnInterface} from './foo';

```

`export type` 有助于在逐文件转译中允许类型再导出。参见 `isolatedModules` 文档。

`export type` 看似也有助于避免为 API 导出值符号。但它并不能给出保证：下游代码仍可能通过其他路径导入该 API。更好的拆分并保证类型与值用法的方式，是真正拆分符号，例如拆成 `UserService` 与 `AjaxUserService`。这样更不易出错，也能更好传达意图。

#### 动态 `import()` 类型

禁止在类型注解中使用 `import()` 函数。

```
let f: import('./foo').Foo;

```

若需要确保导入始终从生成的 JavaScript 中消除，改用 `import type`。

```
import type {Foo} from './foo';

```



#### 使用模块而非命名空间

TypeScript 支持两种组织代码的方法：命名空间与模块，但命名空间不允许使用。也就是说，代码必须通过形如 `import {foo} from 'bar';` 的导入与导出引用其他文件中的代码。

代码禁止使用 `namespace Foo { ... }` 结构。`namespace` 仅可在与外部第三方代码对接所必需时使用。若要在语义上做命名空间，使用独立文件。

代码禁止使用 `require`（如 `import x = require('...');`）做导入。使用 ES6 模块语法。

```
// Bad: do not use namespaces:
namespace Rocket {
    function launch() { ... }
}

// Bad: do not use <reference>
/// <reference path="..."/>

// Bad: do not use require()
import x = require('mydep');

```

> 注意：TypeScript 的 `namespace` 曾被称为内部模块，并曾使用 `module Foo { ... }` 形式的 `module` 关键字。也不要使用那种写法。始终使用 ES6 导入。



## 语言特性

本节界定哪些特性可以使用或不可以使用，以及对其使用的额外约束。

本风格指南未讨论的语言特性可以随意使用，不做使用建议。

### 局部变量声明



#### 使用 const 与 let

始终使用 `const` 或 `let` 声明变量。默认使用 `const`，除非变量需要重新赋值。禁止使用 `var`。

```
const foo = otherValue;  // Use if "foo" never changes.
let bar = someValue;     // Use if "bar" is ever assigned into later on.

```

`const` 与 `let` 是块级作用域，与大多数其他语言中的变量类似。JavaScript 中的 `var` 是函数作用域，可能导致难以理解的缺陷。不要使用它。

```
var foo = someValue;     // Don't use - var scoping is complex and causes bugs.

```

变量禁止在声明之前使用。

#### 每次声明一个变量

每个局部变量声明只声明一个变量：不使用如 `let a = 1, b = 2;` 这类声明。

### 数组字面量



#### 禁止使用 `Array` 构造函数

禁止使用带或不带 `new` 的 `Array()` 构造函数。其用法令人困惑且相互矛盾：

```
const a = new Array(2); // [undefined, undefined]
const b = new Array(2, 3); // [2, 3];

```

改为始终使用方括号初始化数组，或用 `from` 按指定大小初始化 `Array`：

```
const a = [2];
const b = [2, 3];

// Equivalent to Array(2):
const c = [];
c.length = 2;

// [0, 0, 0, 0, 0]
Array.from<number>({length: 5}).fill(0);

```



#### 禁止在数组上定义属性

禁止在数组上定义或使用非数值属性（`length` 除外）。改用 `Map`（或 `Object`）。

#### 数组解构

数组字面量可用在赋值左侧以执行解构（例如从单个数组或可迭代对象解包多个值）。可以包含末尾“rest”元素（`...` 与变量名之间无空格）。未使用的元素应当省略。

```
const [a, b, c, ...rest] = generateResults();
let [, b,, d] = someArray;

```

解构也可用于函数参数。若解构的数组参数可选，始终将默认值指定为 `[]`，并在左侧提供默认值：

```
function destructured([a = 4, b = 2] = []) { … }

```

不允许：

```
function badDestructuring([a, b] = [4, 2]) { … }

```

提示：向函数参数或返回值（解）包多个值时，在可能时优先使用对象解构而非数组解构，因为可以为各个元素命名并为每个指定不同的类型。

### 对象字面量



#### 禁止使用 `Object` 构造函数

禁止使用 `Object` 构造函数。改用对象字面量（`{}` 或 `{a: 0, b: 1, c: 2}`）。

#### 迭代对象

用 `for (... in ...)` 迭代对象容易出错。它会包含原型链上的可枚举属性。

禁止使用未过滤的 `for (... in ...)` 语句：

```
for (const x in someObj) {
    // x could come from some parent prototype!
}

```

要么用 `if` 语句显式过滤值，要么使用 `for (... of Object.keys(...))`。

```
for (const x in someObj) {
    if (!someObj.hasOwnProperty(x)) continue;
    // now x was definitely defined on someObj
}
for (const x of Object.keys(someObj)) { // note: for _of_!
    // now x was definitely defined on someObj
}
for (const [key, value] of Object.entries(someObj)) { // note: for _of_!
    // now key was definitely defined on someObj
}

```



#### 使用展开语法

使用展开语法 `{...bar}` 是创建对象浅拷贝的便捷写法。在对象初始化中使用展开时，后出现的同键值会替换先出现的值。

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

避免展开原型不是 Object 原型的对象（例如类定义、类实例、函数），因为行为不直观（仅浅拷贝可枚举的非原型属性）。

```
// Creates {0: 'a', 1: 'b', 2: 'c'} but has no length
const fooStrings = ['a', 'b', 'c'];
const ids = {...fooStrings};

```

```
const options = {foo: 1, bar: 2};
const extended = {...options, baz: 3};

```



#### 计算属性名

计算属性名（例如 `{['key' + foo()]: 42}`）允许使用，并视为字典风格（带引号）的键（即禁止与不带引号的键混用），除非计算属性是 symbol（例如 `[Symbol.iterator]`）。

#### 对象解构

对象解构模式可用在赋值左侧以执行解构，并从单个对象解包多个值。

解构对象也可用作函数参数，但应当尽量简单：单层不带引号的简写属性。参数解构中禁止使用更深层次的嵌套与计算属性。在解构参数的左侧指定任何默认值（`{str = 'some default'} = {}`，而非 `{str} = {str: 'some default'}`）；若解构对象本身可选，必须默认为 `{}`。

示例：

```
interface Options {
    /** The number of times to do something. */
    num?: number;

    /** A string to do stuff to. */
    str?: string;
}

function destructured({num, str = 'default'}: Options = {}) {}

```

不允许：

```
function nestedTooDeeply({x: {num, str}}: {x: Options}) {}
function nontrivialDefault({num, str}: Options = {num: 42, str: 'default'}) {}

```



### 类



#### 类声明

类声明禁止以分号结束：

```
class Foo {
}

```

```
class Foo {
}; // Unnecessary semicolon

```

相反，包含类表达式的语句必须以分号结束：

```
export const Baz = class extends Bar {
    method(): number {
        return this.x;
    }
}; // Semicolon here as this is a statement, not a declaration

```

```
exports const Baz = class extends Bar {
    method(): number {
        return this.x;
    }
}

```

类声明花括号与其他类内容之间是否空行，既不鼓励也不禁止：

```
// No spaces around braces - fine.
class Baz {
    method(): number {
        return this.x;
    }
}

// A single space around both braces - also fine.
class Foo {

    method(): number {
        return this.x;
    }

}

```



#### 不要创建仅在构造函数中使用的成员变量

若变量仅在构造函数中使用，可迁移为构造函数体作用域内的变量，这会使类更无状态，便于后续开发者推理。

有些类有仅在构造函数中调用的方法，它们更新仅在类构造期间使用的类状态。基于同样理由，这些类状态也应当迁移为构造函数局部变量。

```
class MyClass {
    // BAD: onlyUsedInCtor is only used in the constructor and nowhere else after
    // class initialization.
    private readonly onlyUsedInCtor = ...;
    private readonly otherDataStructure = ...;
    constructor(
        // BAD: Services only used in the constructor but kept after ctor execution.
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
        // GOOD: Services only used in constructor and dropped after ctor finishes.
        serviceA: ServiceA,
        serviceB: ServiceB,
        serviceC: ServiceC,
    ) {
        // GOOD: onlyUsedInCtor is a constructor-local variable.
        const onlyUsedInCtor =
            someFunctionOf(serviceA.getA(), serviceB.getB(), serviceC.getC());
        this.otherDataStructure = computeOther(onlyUsedInCtor);
    }
}

```



#### 类方法声明

类方法声明禁止用分号分隔各个方法声明：

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
    }; // <-- unnecessary
}

```

方法声明应当与周围代码用单个空行分隔：

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



##### 覆盖 toString

可以覆盖 `toString` 方法，但必须始终成功，且不得有可见副作用。

提示：尤其要小心从 toString 调用其他方法，因为异常情况可能导致无限循环。

#### 静态方法



##### 避免私有静态方法

在不影响可读性的情况下，优先使用模块局部函数，而非私有静态方法。

##### 不要依赖动态派发

代码不应依赖静态方法的动态派发。静态方法应当只在直接定义它的基类本身上调用。禁止在可能包含构造函数或子类构造函数的动态实例变量上调用静态方法（若这样做，必须用 `@nocollapse` 定义），也禁止直接在未自行定义该方法的子类上调用。

不允许：

```
// Context for the examples below (this class is okay by itself)
class Base {
    /** @nocollapse */ static foo() {}
}
class Sub extends Base {}

// Discouraged: don't call static methods dynamically
function callFoo(cls: typeof Base) {
    cls.foo();
}

// Disallowed: don't call static methods on subclasses that don't define it themselves
Sub.foo();

// Disallowed: don't access this in static methods.
class MyClass {
    static foo() {
        return this.staticField;
    }
}
MyClass.staticField = 1;

```



##### 避免静态 `this` 引用

代码禁止在静态上下文中使用 `this`。

JavaScript 允许通过 `this` 访问静态字段。与其他语言不同，静态字段也会被继承。

```
class ShoeStore {
    static storage: Storage = ...;

    static isAvailable(s: Shoe) {
        // Bad: do not use `this` in a static method.
        return this.storage.has(s.id);
    }
}

class EmptyShoeStore extends ShoeStore {
    static storage: Storage = EMPTY_STORE;  // overrides storage from ShoeStore
}

```

为什么？

这类代码通常出人意料：作者可能不期望能通过 this 指针访问静态字段，也可能对它们可被覆盖感到惊讶——这一特性并不常用。

这类代码还会鼓励持有大量静态状态的反模式，从而带来可测试性问题。

#### 构造函数

构造函数调用必须使用括号，即使不传参数：

```
const x = new Foo;

```

```
const x = new Foo();

```

省略括号可能导致细微错误。下面两行不等价：

```
new Foo().Bar();
new Foo.Bar();

```

无需提供空构造函数，或仅委托给父类的构造函数，因为若未指定，ES2015 会提供默认类构造函数。但带有参数属性、可见性修饰符或参数装饰器的构造函数，即使构造函数体为空，也不应省略。

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

构造函数应当在上下两侧都与周围代码用单个空行分隔：

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



#### 类成员



##### 禁止 #private 字段

禁止使用私有字段（亦称私有标识符）：

```
class Clazz {
    #ident = 1;
}

```

改用 TypeScript 的可见性注解：

```
class Clazz {
    private ident = 1;
}

```

私有标识符在由 TypeScript 降级时会导致显著的输出体积与性能回退，且在 ES2015 之前不受支持。它们只能降级到 ES2015，不能更低。同时，在用静态类型检查强制可见性时，它们也没有显著收益。

##### 使用 readonly

对构造函数外永不重新赋值的属性，用 `readonly` 修饰符标记（不必深度不可变）。

##### 参数属性

与其把明显的初始化值手动接到类成员，不如使用 TypeScript 参数属性。

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

若参数属性需要文档，使用 `@param` JSDoc 标签。

##### 字段初始化器

若初始化类成员不依赖构造函数参数或参数属性，在声明处初始化。有时这能让你完全去掉构造函数。

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

由于 TypeScript 将此模式转译为 JavaScript 的方式，可以从字段初始化器引用参数属性。该转译正在改变以匹配 JavaScript 语言语义，从字段初始化器引用参数属性将变成 TypeScript 编译错误，因此应当避免此模式。

```
class Foo {
    // BAD: references a property (`this.state`) that will be
    // initialized after this field.
    private readonly userList = initializeUserList(this.state);

    constructor(private readonly state: InitialState) {}
}

```

```
class Foo {
    // GOOD: this must be initialized in the constructor
    private readonly userList: string[];

    // This might allow converting the parameter property into a normal
    // constructor parameter.
    constructor(state: InitialState) {
        this.userList = initializeUserList(state);
    }
}

```

提示：构造函数结束后，禁止向实例添加或移除属性，因为这会显著妨碍 VM 优化类的“形状”。可能稍后填充的可选字段应当显式初始化为 `undefined`，以防止之后的形状变化。

##### 在类词法作用域外使用的属性

从包含类的词法作用域外使用的属性，禁止使用 `private` 可见性，因为它们在包含类的词法作用域外被使用。

例外：仅从模板使用的 Angular 组件属性允许使用 `private` 可见性。

按属性情况适当使用 `protected` 或 `public`。

TypeScript 代码禁止使用 `obj['foo']` 绕过属性可见性。

为什么？

当属性为 `private` 时，你是在向自动化系统与人类声明：对该属性的访问仅限于声明类的方法，他们会依赖这一点。例如，未使用代码检查会标记看似未使用的私有属性，即使其他文件设法绕过了可见性限制。

尽管看起来 `obj['foo']` 可在 TypeScript 编译器中绕过可见性，通过调整构建规则即可打破此模式，且也违反优化兼容性。

##### Getter 与 setter

类成员可以使用 getter 与 setter（亦称访问器）。getter 方法必须是纯函数（即结果一致且无副作用：getter 禁止改变可观察状态）。它们也有助于限制内部或冗长实现细节的可见性（如下所示）。

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
        return this.nextId++; // Bad: getter changes observable state
    }
}

```

若用访问器隐藏类属性，被隐藏属性可用任意完整单词作前缀或后缀，如 `internal` 或 `wrapped`。使用这些私有属性时，尽可能通过访问器取值。属性的至少一个访问器必须是非平凡的：禁止仅为隐藏属性而定义“透传”访问器。改为将属性设为 public（或考虑设为 `readonly`，而非只定义无 setter 的 getter）。

```
class Foo {
    private wrappedBar = '';
    get bar() {
        return this.wrappedBar || 'bar';
    }

    set bar(wrapped: string) {
        this.wrappedBar = wrapped.trim();
    }
}

```

```
class Bar {
    private barInternal = '';
    // Neither of these accessors have logic, so just make bar public.
    get bar() {
        return this.barInternal;
    }

    set bar(value: string) {
        this.barInternal = value;
    }
}

```

禁止用 `Object.defineProperty` 定义 getter 与 setter，因为这会干扰属性重命名。

##### 计算属性

类中仅当属性为 symbol 时才可使用计算属性。不允许字典风格属性（即带引号或非 symbol 的计算键）。对逻辑上可迭代的任何类，应当定义 `[Symbol.iterator]` 方法。除此之外，应当谨慎使用 `Symbol`。

提示：小心使用任何其他内置 symbol（例如 `Symbol.isConcatSpreadable`），因为编译器不会为其提供 polyfill，因此在较旧浏览器中无法工作。

#### 可见性

限制属性、方法乃至整个类型的可见性有助于保持代码解耦。

- 尽可能限制符号可见性。
- 考虑将私有方法转换为同一文件内、任何类外的非导出函数，并将私有属性移到单独的非导出类中。
- TypeScript 符号默认为 public。除声明非 readonly 的公有参数属性（在构造函数中）外，禁止使用 `public` 修饰符。

```
class Foo {
    public bar = new Bar();  // BAD: public modifier not needed

    constructor(public readonly baz: Baz) {}  // BAD: readonly implies it's a property which defaults to public
}

```

```
class Foo {
    bar = new Bar();  // GOOD: public modifier not needed

    constructor(public baz: Baz) {}  // public modifier allowed
}

```



#### 禁止的类模式



##### 禁止直接操作 `prototype`

`class` 关键字允许比定义 `prototype` 属性更清晰、更易读的类定义。普通实现代码没有理由操作这些对象。Mixin 以及修改内置对象的原型明确禁止。

例外：框架代码（如 Polymer 或 Angular）可能需要使用 `prototype`，且不应为避免这样做而采用更糟的变通办法。

### 函数



#### 术语

函数有许多不同类型，其间有细微差别。本指南使用与 MDN 一致的下列术语：

- “function declaration”（函数声明）：使用 `function` 关键字的声明（即非表达式）
- “function expression”（函数表达式）：通常用于赋值或作为参数传递、使用 `function` 关键字的表达式
- “arrow function”（箭头函数）：使用 `=>` 语法的表达式
- “block body”（块体）：带花括号的箭头函数右侧
- “concise body”（简洁体）：不带花括号的箭头函数右侧

方法与类/构造函数不在本节范围内。

#### 具名函数优先使用函数声明

定义具名函数时，优先使用函数声明，而非箭头函数或函数表达式。

```
function foo() {
    return 42;
}

```

```
const foo = () => 42;

```

例如在需要显式类型注解时，可以使用箭头函数。

```
interface SearchFunction {
    (source: string, subString: string): boolean;
}

const fooSearch: SearchFunction = (source, subString) => { ... };

```



#### 嵌套函数

嵌套在其他方法或函数中的函数可按情况使用函数声明或箭头函数。尤其在方法体中，优先使用箭头函数，因为它们可访问外部的 `this`。

#### 禁止使用函数表达式

禁止使用函数表达式。改用箭头函数。

```
bar(() => { this.doSomething(); })

```

```
bar(function() { ... })

```

例外：仅当代码必须动态重新绑定 `this`（但不鼓励）时，或对于生成器函数（没有箭头语法）时，才可使用函数表达式。

#### 箭头函数体

按情况对箭头函数使用简洁体（即表达式）或块体。

```
// Top level functions use function declarations.
function someFunction() {
    // Block bodies are fine:
    const receipts = books.map((b: Book) => {
        const receipt = payMoney(b.price);
        recordTransaction(receipt);
        return receipt;
    });

    // Concise bodies are fine, too, if the return value is used:
    const longThings =
            myValues.filter((v) => v.length > 1000).map((v) => String(v));

    function payMoney(amount: number) {
        // function declarations are fine, but must not access `this`.
    }

    // Nested arrow functions may be assigned to a const.
    const computeTax = (amount: number) => amount * 0.12;
}

```

仅当函数的返回值确实被使用时才使用简洁体。块体可确保此时返回类型为 `void`，并防止潜在副作用。

```
// BAD: use a block body if the return value of the function is not used.
myPromise.then((v) => console.log(v));
// BAD: this typechecks, but the return value still leaks.
let f: () => void;
f = () => 1;

```

```
// GOOD: return value is unused, use a block body.
myPromise.then((v) => {
    console.log(v);
});
// GOOD: code may use blocks for readability.
const transformed = [1, 2, 3].map((v) => {
    const intermediate = someComplicatedExpr(v);
    const more = acrossManyLines(intermediate);
    return worthWrapping(more);
});
// GOOD: explicit `void` ensures no leaked return value
myPromise.then((v) => void console.log(v));

```

提示：可使用 `void` 运算符确保带表达式体的箭头函数在结果未使用时返回 `undefined`。

#### 重新绑定 `this`

函数表达式与函数声明禁止使用 `this`，除非它们专门用于重新绑定 `this` 指针。多数情况下可通过箭头函数或显式参数避免重新绑定 `this`。

```
function clickHandler() {
    // Bad: what's `this` in this context?
    this.textContent = 'Hello';
}
// Bad: the `this` pointer reference is implicitly set to document.body.
document.body.onclick = clickHandler;

```

```
// Good: explicitly reference the object from an arrow function.
document.body.onclick = () => { document.body.textContent = 'hello'; };
// Alternatively: take an explicit parameter
const setTextFn = (e: HTMLElement) => { e.textContent = 'hello'; };
document.body.onclick = setTextFn.bind(null, document.body);

```

绑定 `this` 时优先使用箭头函数，而非 `f.bind(this)`、`goog.bind(f, this)` 或 `const self = this` 等方法。

#### 优先将箭头函数作为回调传递

回调可能以意外参数被调用，这些参数能通过类型检查但仍导致逻辑错误。

避免将具名回调传给高阶函数，除非你确信两个函数调用签名都稳定。尤其要小心较少使用的可选参数。

```
// BAD: Arguments are not explicitly passed, leading to unintended behavior
// when the optional `decimals` argument gets the array indices 0, 1, and 2.
const strs = [1.23, 4.56, 7.89].map(googFormat.numericValueToString);
// > ['1', '4.6', '7.89'];

```

改为优先传递显式将参数转发给具名回调的箭头函数。

```
// GOOD: Arguments are explicitly passed to the callback
const strs = [1.23, 4.56, 7.89].map((n) => googFormat.numericValueToString(n));
// > ['1.23', '4.56', '7.89']

// GOOD: Function is locally defined and is designed to be used as a callback
function dayFilter(element: string|null|undefined) {
    return element != null && element.endsWith('day');
}

const days = ['tuesday', undefined, 'juice', 'wednesday'].filter(dayFilter);

```



#### 作为属性的箭头函数

类通常不应包含初始化为箭头函数的属性。箭头函数属性要求调用方理解被调用方的 `this` 已绑定，这会增加对 `this` 是什么的困惑，且使用此类处理器的调用点与引用看起来像是错误的（即需要非局部知识才能判断其正确性）。代码应当始终使用箭头函数调用实例方法（`const handler = (x) => { this.listener(x); };`），且不应获取或传递实例方法的引用（

`const handler = this.listener; handler(x);`

）。

> 注意：在某些特定情形下，例如在模板中绑定函数时，作为属性的箭头函数很有用，能写出更易读的代码。对本规则需酌情判断。另见下文“事件处理器”一节。

```
class DelayHandler {
    constructor() {
        // Problem: `this` is not preserved in the callback. `this` in the callback
        // will not be an instance of DelayHandler.
        setTimeout(this.patienceTracker, 5000);
    }
    private patienceTracker() {
        this.waitedPatiently = true;
    }
}

```

```
// Arrow functions usually should not be properties.
class DelayHandler {
    constructor() {
        // Bad: this code looks like it forgot to bind `this`.
        setTimeout(this.patienceTracker, 5000);
    }
    private patienceTracker = () => {
        this.waitedPatiently = true;
    }
}

```

```
// Explicitly manage `this` at call time.
class DelayHandler {
    constructor() {
        // Use anonymous functions if possible.
        setTimeout(() => {
            this.patienceTracker();
        }, 5000);
    }
    private patienceTracker() {
        this.waitedPatiently = true;
    }
}

```



#### 事件处理器

当无需卸载处理器时（例如事件由类自身发出），事件处理器可以使用箭头函数。若处理器需要卸载，箭头函数属性是正确做法，因为它们自动捕获 `this` 并提供可卸载的稳定引用。

```
// Event handlers may be anonymous functions or arrow function properties.
class Component {
    onAttached() {
        // The event is emitted by this class, no need to uninstall.
        this.addEventListener('click', () => {
            this.listener();
        });
        // this.listener is a stable reference, we can uninstall it later.
        window.addEventListener('onbeforeunload', this.listener);
    }
    onDetached() {
        // The event is emitted by window. If we don't uninstall, this.listener will
        // keep a reference to `this` because it's bound, causing a memory leak.
        window.removeEventListener('onbeforeunload', this.listener);
    }
    // An arrow function stored in a property is bound to `this` automatically.
    private listener = () => {
        confirm('Do you want to exit the page?');
    }
}

```

禁止在安装事件处理器的表达式中使用 `bind`，因为它会创建无法卸载的临时引用。

```
// Binding listeners creates a temporary reference that prevents uninstalling.
class Component {
    onAttached() {
        // This creates a temporary reference that we won't be able to uninstall
        window.addEventListener('onbeforeunload', this.listener.bind(this));
    }
    onDetached() {
        // This bind creates a different reference, so this line does nothing.
        window.removeEventListener('onbeforeunload', this.listener.bind(this));
    }
    private listener() {
        confirm('Do you want to exit the page?');
    }
}

```



#### 参数初始化器

可选函数参数可以给出默认初始化器，在省略实参时使用。初始化器禁止有任何可观察副作用。初始化器应当尽量简单。

```
function process(name: string, extraContext: string[] = []) {}
function activate(index = 0) {}

```

```
// BAD: side effect of incrementing the counter
let globalCounter = 0;
function newId(index = globalCounter++) {}

// BAD: exposes shared mutable state, which can introduce unintended coupling
// between function calls
class Foo {
    private readonly defaultPaths: string[];
    frobnicate(paths = defaultPaths) {}
}

```

谨慎使用默认参数。当有不止少量、且没有自然顺序的可选参数时，优先使用解构以创建可读的 API。

#### 在适当时优先使用 rest 与 spread

使用 rest 参数，而非访问 `arguments`。禁止将局部变量或参数命名为 `arguments`，这会令人困惑地遮蔽内置名称。

```
function variadic(array: string[], ...numbers: number[]) {}

```

使用函数展开语法，而非 `Function.prototype.apply`。

#### 格式化函数

函数体开头或结尾禁止空行。

函数体内可以谨慎使用单个空行，以形成语句的逻辑分组。

生成器应当把 `*` 附在 `function` 与 `yield` 关键字上，写成 `function* foo()` 与 `yield* iter`，而非

`function *foo()`

或

`yield *iter`

。

单参数箭头函数左侧周围的括号建议使用但不强制。

rest 或 spread 语法中，`...` 之后禁止空格。

```
function myFunction(...elements: number[]) {}
myFunction(...array, ...iterable, ...generator());

```



#### 函数长度

编写小而专注的函数与类方法。

尽管对函数与方法长度没有硬性上限，若超过约 40 行，请考虑能否在不损害程序结构的前提下拆分。

这不是精确科学，但以下是方法可能过于复杂的一些信号：

- 有多层嵌套。
- 由多个独立代码块组成，每块都需要注释解释其作用。
- 必须在不同位置处理不同类型的异常。
- 无法一次完整显示在屏幕上。

若处理这样的函数很困难、错误难以调试，或想在多个不同上下文中使用其中一部分，考虑将函数拆成更小、更易管理的片段。注意：仅使用一次的私有辅助方法或类并无问题；它们可以是提高代码可读性的有用工具。

### this

仅在类构造函数与方法中、声明了显式 `this` 类型的函数中（例如 `function func(this: ThisType, ...)`），或在可使用 `this` 的作用域内定义的箭头函数中使用 `this`。

禁止用 `this` 引用全局对象、`eval` 的上下文、事件目标，或不必要地 `call()` / `apply()` 的函数。

```
this.alert('Hello');

```



### 原始字面量



#### 字符串字面量



##### 使用单引号

普通字符串字面量用单引号（`'`）分隔，而非双引号（`"`）。

例外：若字符串包含单引号字符，可用双引号分隔以避免转义引号。

##### 禁止行续接

在普通或模板字符串字面量中，禁止使用行续接（即在字符串字面量内用反斜杠结束一行）。尽管 ES5 允许这样做，若斜杠后有尾随空白可能导致棘手错误，且对读者不够明显。

不允许：

```
const LONG_STRING = 'This is a very very very very very very very long string. \
        It inadvertently contains long stretches of spaces due to how the \
        continued lines are indented.';

```

改为写：

```
const LONG_STRING = 'This is a very very very very very very long string. ' +
        'It does not contain long stretches of spaces because it uses ' +
        'concatenated strings.';
const SINGLE_STRING =
        'http://it.is.also/acceptable_to_use_a_single_long_string_when_breaking_would_hinder_search_discoverability';

```



##### 模板字面量

对复杂字符串拼接优先使用模板字面量（用反引号 ``` 分隔），尤其在涉及多个字符串字面量时。模板字面量可以跨多行。

若模板字面量跨多行，不必遵循包围块的缩进，但若增加的空白无关紧要，也可以遵循。

示例：

```
function arithmetic(a: number, b: number) {
    return `Here is a table of arithmetic operations:
${a} + ${b} = ${a + b}
${a} - ${b} = ${a - b}
${a} * ${b} = ${a * b}
${a} / ${b} = ${a / b}`;
}

```



#### 数字字面量

数字可以用十进制、十六进制、八进制或二进制指定。十六进制、八进制与二进制分别精确使用小写前缀 `0x`、`0o` 与 `0b`。除非紧随其后为 `x`、`o` 或 `b`，否则禁止前导零。

#### 类型强制转换

TypeScript 代码可以使用 `String()` 与 `Boolean()`（注意：不要用 `new`！）函数、字符串模板字面量，或 `!!` 进行类型强制转换。

```
const bool = Boolean(0);
const str = String(aNumber);
const bool2 = !!str;
const str2 = `result: ${bool2}`;

```

枚举类型的值（包括枚举类型与其他类型的联合）禁止用 `Boolean()` 或 `!!` 转为布尔值，必须改用比较运算符显式比较。

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

为什么？

多数情况下，枚举名在运行时映射到哪个数字或字符串值并不重要，因为源码中按名称引用枚举类型的值。因此工程师习惯不去想这一点，所以真正重要的情形是不可取的，因为会令人惊讶。将枚举转为布尔值即属此类；尤其是默认情况下，第一个声明的枚举值为假值（因为是 0），其余为真值，这很可能出乎意料。阅读使用枚举值的代码的人甚至可能不知道它是否是第一个声明的值。

用字符串拼接转为字符串是不鼓励的，因为我们会检查加号运算符的操作数类型是否匹配。

##### 强制转换为数字

数字解析可能以多种方式失败，有许多令人惊讶的边界情况，且不同解析方法行为各异有时不一致（例如空白、空字符串、科学计数法、溢出为无穷、进制前缀等）。此外，在错误层解析往往是代码异味。代码必须检查任何数值强制转换的输出，并显式处理任何可能的不抛出失败情况（例如处理任何 `NaN` 结果）。

代码禁止使用一元加号（例如 `+str`）或 `parseFloat` 将字符串强制转换为数字。前者在代码审查中太容易漏看，后者会静默忽略输入字符串的尾随垃圾。这两种情况都优先使用 `Number`。

除非需要非十进制进制，否则代码禁止使用 `parseInt`。在此情况下，解析前必须检查输入字符串的有效性（即所有字符都是有效数字），以确保不会静默忽略尾随垃圾。输出也必须对照 `NaN` 检查。

```
const x = +y;
const x1 = parseFloat(y1);

```

```
const x = Number(y);
if (!isFinite(x)) throw new Error(...);

```



##### 隐式强制转换

在已有隐式布尔强制转换的条件子句中（具体为 `if`、`for` 与 `while` 语句中的条件），禁止使用显式布尔强制转换。

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

与显式转换一样，枚举类型的值（包括枚举类型与其他类型的联合）禁止隐式强制转换为布尔值，必须改用比较运算符显式比较。

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

其他类型的值可以隐式强制转换为布尔值，或用比较运算符显式比较：

```
// Explicitly comparing > 0 is OK:
if (arr.length > 0) {...}
// so is relying on boolean coercion:
if (arr.length) {...}

```



### 控制结构



#### 控制流语句与块

控制流语句（`if`、`else`、`for`、`do`、`while` 等）始终对包含的代码使用带花括号的块，即使体中只有一条语句。非空块的第一条语句必须单独起行。

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

例外：能写在一行上的 `if` 语句可以省略块。

```
if (x) x.doFoo();

```



##### 控制语句中的赋值

优先避免在控制语句内给变量赋值。在控制语句内，赋值很容易被误认为相等检查。

```
if (x = someFunction()) {
    // Assignment easily mistaken with equality check
    // ...
}

```

```
x = someFunction();
if (x) {
    // ...
}

```

在更希望在控制语句内赋值的情况下，用额外括号包住赋值，以表明是有意为之。

```
while ((x = someFunction())) {
    // Double parenthesis shows assignment is intentional
    // ...
}

```



##### 迭代容器

优先使用 `for (... of someArr)` 迭代数组。也允许 `Array.prototype.forEach` 与普通 `for` 循环：

```
for (const x of someArr) {
    // x is a value of someArr.
}

for (let i = 0; i < someArr.length; i++) {
    // Explicitly count if the index is needed, otherwise use the for/of form.
    const x = someArr[i];
    // ...
}
for (const [i, x] of someArr.entries()) {
    // Alternative version of the above.
}

```

`for`-`in` 循环仅可用于字典风格对象（详见下文）。禁止用 `for (... in ...)` 迭代数组，因为它会反直觉地给出数组的索引（作为字符串！），而非值：

```
for (const x in someArray) {
    // x is the index!
}

```

在 `for`-`in` 循环中应当使用 `Object.prototype.hasOwnProperty` 以排除不需要的原型属性。可能时优先对 `Object.keys`、`Object.values` 或 `Object.entries` 使用 `for`-`of`，而非 `for`-`in`。

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



#### 分组括号

仅当作者与审查者都同意：去掉可选分组括号后没有合理误解代码的风险，且它们也不会让代码更易读时，才省略这些括号。假定每位读者都熟记整个运算符优先级表是不合理的。

在 `delete`、`typeof`、`void`、`return`、`throw`、`case`、`in`、`of` 或 `yield` 之后的整个表达式周围，禁止使用不必要的括号。

#### 异常处理

异常是语言的重要部分，在出现异常情况时应当使用。

自定义异常是从函数传递额外错误信息的好方式。在原生 `Error` 类型不足时，应当定义并使用它们。

优先抛出异常，而非临时的错误处理方式（例如传递错误容器引用类型，或返回带错误属性的对象）。

##### 使用 `new` 实例化错误

实例化异常时始终使用 `new Error()`，而非仅调用 `Error()`。两种形式都会创建新的 `Error` 实例，但使用 `new` 与其他对象的实例化方式更一致。

```
throw new Error('Foo is not a valid bar.');

```

```
throw Error('Foo is not a valid bar.');

```



##### 只抛出错误

尽管 JavaScript 允许抛出任意值，仅当抛出值为 `Error` 时才会填充堆栈跟踪。禁止抛出原始值（包括字符串、数字、null 或 undefined）或不是 `Error` 或其子类实例的对象。此限制也适用于所有可能抛出其参数的 API，包括 `Promise.reject` 或 `AbortSignal` 的各种 `abort` 方法。

```
// bad: does not get a stack trace.
throw 'oh noes!';
// For promises
new Promise((resolve, reject) => void reject('oh noes!'));
Promise.reject();
Promise.reject('oh noes!');
// For abort signals
new AbortController().abort('my custom abort error');
AbortSignal.abort('my other custom abort error');

```

改为只抛出（`Error` 的子类）：

```
// Throw only Errors
throw new Error('oh noes!');
// ... or subtypes of Error.
class MyError extends Error {}
throw new MyError('my oh noes!');
// For promises
new Promise((resolve) => resolve()); // No reject is OK.
new Promise((resolve, reject) => void reject(new Error('oh noes!')));
Promise.reject(new Error('oh noes!'));
// For abort signals
new AbortController().abort();  // No reason is OK.
AbortSignal.abort();
new AbortController().abort(new Error('my custom abort error'));
AbortSignal.abort(new Error('my other custom abort error'));

```

注意：无参数调用 `AbortController#abort` 或 `AbortSignal.abort` 是有效的，因为默认会创建新的 “AbortError” `DOMException` 并赋为 `AbortSignal#reason`（见 MDN）。

##### 捕获与重新抛出

捕获错误时，代码应当假定所有抛出的错误都是 `Error` 的实例。

```
function assertIsError(e: unknown): asserts e is Error {
    if (!(e instanceof Error)) throw new Error("e is not an Error");
}

try {
    doSomething();
} catch (e: unknown) {
    // All thrown errors must be Error subtypes. Do not handle
    // other possible values unless you know they are thrown.
    assertIsError(e);
    displayError(e.message);
    // or rethrow:
    throw e;
}

```

异常处理器禁止防御性地处理非 `Error` 类型，除非所调用的 API 确凿已知会违反上述规则抛出非 `Error`。在那种情况下，应当加入注释以明确指出非 `Error` 的来源。

```
try {
    badApiThrowingStrings();
} catch (e: unknown) {
    // Note: bad API throws strings instead of errors.
    if (typeof e === 'string') { ... }
}

```

避免过度防御性编程。对多数代码中不存在的问题重复相同防御，会导致无用的样板代码。

##### 空 catch 块

对捕获的异常完全不采取行动极少正确。当 catch 块中确实适合不采取任何行动时，用注释解释为何合理。

```
    try {
        return handleNumericResponse(response);
    } catch (e: unknown) {
        // Response is not numeric. Continue to handle as text.
    }
    return handleTextResponse(response);

```

不允许：

```
    try {
        shouldFail();
        fail('expected an error');
    } catch (expected: unknown) {
    }

```

提示：与某些其他语言不同，上述模式根本不起作用，因为这会捕获 `fail` 抛出的错误。改用 `assertThrows()`。

##### ErrorOptions 的 cause 必须是 Error 对象

为 ErrorOptions 参数传参时，`cause` 属性必须用错误子类型初始化。这有效地创建带有有用堆栈跟踪的错误对象链。

```
try {
    ...
} catch (e: unknown) {
    if (e instanceof Error) {
        throw new Error('Something went wrong', {cause: e});
    }
}

```

```
const status = doSomething();
if (status !== success) {
    throw new Error('doSomething failed', {cause: status});
}

```

若 `cause` 初始化器引用类型为 unknown 的 catch 子句变量，可以省略类型检查，因为我们的代码库假定不能抛出 `Error` 对象以外的任何东西。

```
try {
    ...
} catch (e: unknown) {
    // No need to check the type of e.
    throw new Error('Something went wrong', {cause: e});
}

```

在 TypeScript 中，类型 `Error` 恰好可赋值给 `ErrorOptions`。因此可能意外地把错误对象当作 ErrorOptions 参数传入，这很可能是代码中的缺陷。

```
try {
    ...
} catch (e: unknown) {
    if (e instanceof Error) {
        throw new Error('Something went wrong', e);
    }
}

```



#### Switch 语句

所有 `switch` 语句必须包含 `default` 语句组，即使其中没有代码。`default` 语句组必须放在最后。

```
switch (x) {
    case Y:
        doSomethingElse();
        break;
    default:
        // nothing to do.
}

```

在 switch 块内，每个语句组要么以 `break`、`return` 语句突然终止，要么抛出异常。非空语句组（`case ...`）禁止贯穿（由编译器强制）：

```
switch (x) {
    case X:
        doSomething();
        // fall through - not allowed!
    case Y:
        // ...
}

```

空语句组允许贯穿：

```
switch (x) {
    case X:
    case Y:
        doSomething();
        break;
    default: // nothing to do.
}

```



#### 相等检查

始终使用三等号（`===`）与不等号（`!==`）。双等号运算符会导致容易出错、难以理解且对 JavaScript 虚拟机实现更慢的类型强制转换。另见 JavaScript 相等表。

```
if (foo == 'bar' || baz != bam) {
    // Hard to understand behaviour due to type coercion.
}

```

```
if (foo === 'bar' || baz !== bam) {
    // All good here.
}

```

例外：与字面量 `null` 值比较时，可以使用 `==` 与 `!=` 运算符，以同时覆盖 `null` 与 `undefined` 值。

```
if (foo == null) {
    // Will trigger when foo is null or undefined.
}

```



#### 类型与非空断言

类型断言（`x as SomeType`）与非空断言（`y!`）是不安全的。二者都只是让 TypeScript 编译器静默，但不会插入任何运行时检查来匹配这些断言，因此可能导致程序在运行时崩溃。

因此，没有明显或明确理由时，不应使用类型与非空断言。

不要写如下代码：

```
(x as Foo).foo();

y!.bar();

```

当你想断言类型或非空时，最佳做法是显式编写执行该检查的运行时检查。

```
// assuming Foo is a class.
if (x instanceof Foo) {
    x.foo();
}

if (y) {
    y.bar();
}

```

有时由于代码的某些局部属性，你可以确定断言形式是安全的。在那些情况下，应当补充说明，解释为何可以接受不安全行为：

```
// x is a Foo, because ...
(x as Foo).foo();

// y cannot be null, because ...
y!.bar();

```

若类型或非空断言背后的推理显而易见，注释可以不必。例如，生成的 proto 代码总是可空的，但在该代码上下文中可能众所周知某些字段始终由后端提供。请自行判断。

##### 类型断言语法

类型断言必须使用 `as` 语法（而非尖括号语法）。这在访问成员时强制在断言周围使用括号。

```
const x = (<Foo>z).length;
const y = <Foo>z.length;

```

```
// z must be Foo because ...
const x = (z as Foo).length;

```



##### 双重断言

据 TypeScript 手册，TypeScript 只允许转换为更具体或更不具体版本类型的类型断言。添加不符合此标准的类型断言（`x as Foo`）会给出错误：“Conversion of type ‘X’ to type ‘Y’ may be a mistake because neither type sufficiently overlaps with the other.”

若你确定断言安全，可以执行双重断言。这涉及经由 `unknown` 转换，因为它比所有类型都更不具体。

```
// x is a Foo here, because...
(x as unknown as Foo).fooMethod();

```

使用 `unknown`（而非 `any` 或 `{}`）作为中间类型。

##### 类型断言与对象字面量

用类型注解（`: Foo`）而非类型断言（`as Foo`）指定对象字面量的类型。这样当接口字段随时间变化时，能发现重构缺陷。

```
interface Foo {
    bar: number;
    baz?: string;  // was "bam", but later renamed to "baz".
}

const foo = {
    bar: 123,
    bam: 'abc',  // no error!
} as Foo;

function func() {
    return {
        bar: 123,
        bam: 'abc',  // no error!
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
    bam: 'abc',  // complains about "bam" not being defined on Foo.
};

function func(): Foo {
    return {
        bar: 123,
        bam: 'abc',   // complains about "bam" not being defined on Foo.
    };
}

```



#### 保持 try 块聚焦

在不影响可读性的前提下，限制 try 块内的代码量。

```
try {
    const result = methodThatMayThrow();
    use(result);
} catch (error: unknown) {
    // ...
}

```

```
let result;
try {
    result = methodThatMayThrow();
} catch (error: unknown) {
    // ...
}
use(result);

```

把不会抛出的行移出 try/catch 块，有助于读者了解哪个方法会抛出异常。某些不抛异常的内联调用可以留在里面，因为不值得为临时变量增加额外复杂度。

例外：若 try 块在循环内，可能有性能问题。将 try 块扩大以覆盖整个循环是可以的。

### 装饰器

装饰器是带 `@` 前缀的语法，如 `@MyDecorator`。

禁止定义新装饰器。只使用框架定义的装饰器：

- Angular（例如 `@Component`、`@NgModule` 等）
- Polymer（例如 `@property`）

为什么？

我们通常希望避免装饰器，因为它们曾是实验性特性，此后已与 TC39 提案分道扬镳，且有已知不会修复的缺陷。

使用装饰器时，装饰器必须紧挨其所装饰的符号，中间无空行：

```
/** JSDoc comments go before decorators */
@Component({...})  // Note: no empty line after the decorator.
class MyComp {
    @Input() myField: string;  // Decorators on fields may be on the same line...

    @Input()
    myOtherField: string;  // ... or wrap.
}

```



### 禁止的特性



#### 原始类型的包装对象

TypeScript 代码禁止实例化原始类型 `String`、`Boolean` 与 `Number` 的包装类。包装类有令人惊讶的行为，例如 `new Boolean(false)` 求值为 `true`。

```
const s = new String('hello');
const b = new Boolean(false);
const n = new Number(5);

```

包装器可作为函数调用以进行强制转换（这优先于使用 `+` 或拼接空字符串）或创建 symbol。更多信息见类型强制转换。

#### 自动分号插入

禁止依赖自动分号插入（ASI）。用分号显式结束所有语句。这可防止因不正确的分号插入导致的缺陷。

#### Const 枚举

代码禁止使用 `const enum`；改用普通 `enum`。

TypeScript 枚举已不可变；`const enum` 是与优化相关的独立语言特性，会使枚举对模块的 JavaScript 使用者不可见。

#### Debugger 语句

生产代码中禁止包含 debugger 语句。

```
function debugMe() {
    debugger;
}

```



#### `with`

禁止使用 `with` 关键字。它使代码更难理解，且自 ES5 起已在严格模式中被禁止。

#### 动态代码求值

禁止使用 `eval` 或 `Function(...string)` 构造函数（代码加载器除外）。这些特性潜在危险，且在使用严格内容安全策略的环境中根本无法工作。

#### 非标准特性

禁止使用非标准的 ECMAScript 或 Web 平台特性。

这包括：

- 已标记弃用或已从 ECMAScript / Web 平台完全移除的旧特性（见 MDN）
- 尚未标准化的新 ECMAScript 特性
- 避免使用当前 TC39 工作草案中或仍在提案过程中的特性
- 仅使用当前 ECMA-262 规范中定义的 ECMAScript 特性
- 已提案但尚未完成的 Web 标准：
- 尚未完成提案过程的 WHATWG 提案。
- 非标准语言“扩展”（例如某些外部转译器提供的扩展）

面向特定 JavaScript 运行时的项目（如仅最新 Chrome、Chrome 扩展、Node.JS、Electron）显然可以使用那些 API。在考虑仅在部分浏览器中实现的专有 API 面时要谨慎；考虑是否有通用库能为你抽象该 API 面。

#### 修改内置对象

禁止修改内置类型，无论是向其构造函数还是原型添加方法。避免依赖这样做的库。

除非绝对必要（例如第三方 API 要求），禁止向全局对象添加符号。

## 命名



### 标识符

标识符只能使用 ASCII 字母、数字、下划线（用于常量与结构化测试方法名），以及（很少）‘$’ 符号。

#### 命名风格

TypeScript 在类型中表达信息，因此名称不应装饰类型中已包含的信息。（另见 Testing Blog 了解不应包含什么。）

本规则的一些具体例子：

- 禁止对私有属性或方法使用尾随或前导下划线。
- 禁止对可选参数使用 `opt_` 前缀。
- 对于访问器，见下文访问器规则。
- 除非在其环境中是惯用写法，否则不要特别标记接口（

`IMyInterface`

或

`MyFooInterface`

）。为类引入接口时，起一个能表达该接口为何存在的名称（例如 `class TodoItem` 与 `interface TodoItemStorage`，若接口表达用于 JSON 存储/序列化的格式）。

- 给 `Observable` 加 `$` 后缀是常见外部约定，有助于解决可观察值与具体值之间的混淆。是否有用由各团队自行判断，但应在项目内保持一致。



#### 描述性名称

名称必须对初次阅读者具有描述性且清晰。禁止使用对项目外读者含糊或不熟悉的缩写，也不要通过删除词内字母来缩写。

- 例外：作用域在 10 行或更少的变量（包括非导出 API 的一部分的参数）可以使用短（例如单字母）变量名。

```
// Good identifiers:
errorCount          // No abbreviation.
dnsConnectionIndex  // Most people know what "DNS" stands for.
referrerUrl         // Ditto for "URL".
customerId          // "Id" is both ubiquitous and unlikely to be misunderstood.

```

```
// Disallowed identifiers:
n                   // Meaningless.
nErr                // Ambiguous abbreviation.
nCompConns          // Ambiguous abbreviation.
wgcConnections      // Only your group knows what this stands for.
pcReader            // Lots of things can be abbreviated "pc".
cstmrId             // Deletes internal letters.
kSecondsPerDay      // Do not use Hungarian notation.
customerID          // Incorrect camelcase of "ID".

```



#### 驼峰命名

把名称中的缩写词当作完整单词处理，即使用 `loadHttpUrl`，而非

`loadHTTPURL`

，除非平台名称要求（例如 `XMLHttpRequest`）。

#### 美元符号

标识符一般不应使用 `$`，除非第三方框架的命名约定要求。关于对 `Observable` 值使用 `$`，见上文。

### 按标识符类型的规则

多数标识符名称应当按下表根据标识符类型遵循大小写。


| 风格               | 类别                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `UpperCamelCase` | class / interface / type / enum / decorator / type parameters / TSX 中的组件函数 / JSXElement 类型参数 |
| `lowerCamelCase` | variable / parameter / function / method / property / module alias                           |
| `CONSTANT_CASE`  | 全局常量值，包括枚举值。见下文常量。                                                                           |
| `#ident`         | 永不使用私有标识符。                                                                                   |




#### 类型参数

类型参数（如 `Array<T>` 中）可以使用单个大写字符（`T`）或 `UpperCamelCase`。

#### 测试名称

xUnit 风格测试框架中的测试方法名可以用 `_` 分隔符结构化，例如 `testX_whenY_doesZ()`。

#### 下划线（`_`）前缀/后缀

下划线前缀表示语法上必需但不会使用的标识符。鼓励在下划线后提供有意义的名称，但也允许单独的 `_`。

```
(_projectId, api) => of(!params.disabledApis.includes(api));

[].filter((_, i) => i % 2 === 0);

for await (const _item of getAllTheThings()) {
    count++;
}

using _cleanupFoo = foo();

```

不要对尾随未使用参数使用此风格，那些应当省略。

尾随未使用参数允许出现在专门打算被覆盖的方法上。

```
[].filter((element, _index) => !element.hasSomeProperty());

```

```
[].filter(element => !element.hasSomeProperty());

```

标识符禁止使用 `_` 作后缀。

> 提示：若你只需要数组（或 TypeScript 元组）中的部分元素，可以在解构语句中插入额外逗号以忽略中间元素：
>
> ```
> const [a, , b] = [1, 5, 10]; // a <- 1, b <- 10
>
> ```



#### 导入

模块命名空间导入为 `lowerCamelCase`，而文件为 `snake_case`，这意味着正确的导入在大小写风格上不会匹配，例如

```
import * as fooBar from './foo_bar';

```

某些库可能常用违反此命名方案的命名空间导入前缀，但压倒性的常见开源用法使违反风格更易读。目前仅下列库属于此例外：

- jquery，使用 `$` 前缀
- threejs，使用 `THREE` 前缀



#### 常量

不可变：`CONSTANT_CASE` 表示值意图不被更改，也可用于技术上可修改的值（即未深度冻结的值），以向使用者表明禁止修改。

```
const UNIT_SUFFIXES = {
    'milliseconds': 'ms',
    'seconds': 's',
};
// Even though per the rules of JavaScript UNIT_SUFFIXES is
// mutable, the uppercase shows users to not modify it.

```

常量也可以是类的 `static readonly` 属性。

```
class Foo {
    private static readonly MY_SPECIAL_NUMBER = 5;

    bar() {
        return 2 * Foo.MY_SPECIAL_NUMBER;
    }
}

```

全局：仅模块级声明的符号、模块级类的静态字段，以及模块级枚举的值，可以使用 `CONST_CASE`。若值在程序生命周期内可被实例化多次（例如函数内声明的局部变量，或嵌套在函数中的类上的静态字段），则必须使用 `lowerCamelCase`。局部作用域别名除外，应当使用既有标识符的格式。

若值是实现接口的箭头函数，则可以声明为 `lowerCamelCase`。

#### 别名

创建既有符号的局部作用域别名时，使用既有标识符的格式。局部别名必须匹配源的既有命名与格式。变量的局部别名使用 `const`，类字段使用 `readonly` 属性。

> 注意：若你创建别名只是为了在所选框架的模板中暴露它，记得也应用正确的访问修饰符。

```
const {BrewStateEnum} = SomeType;
const CAPACITY = 5;

class Teapot {
    readonly BrewStateEnum = BrewStateEnum;
    readonly CAPACITY = CAPACITY;
}

```



#### 覆盖与实现的成员

覆盖、实现或收窄基类或接口成员的属性与方法，或出现在上下文类型化对象字面量中的成员，必须匹配既有声明的名称与大小写才能编译。因此大小写规则仅适用于成员的原始声明，该声明必须遵循这些规则，除非外部约定另有要求。若可能，考虑修复原始声明的名称。

```
interface ServerResponse {
    // Disallowed: property names must use lowerCamelCase (or CONSTANT_CASE).
    // The correct name here would be `errorCode`.
    error_code: number;
}

```

```
// When the existing name is required to match an external contract, suppress
// the lint warning on the original declaration and include a rationale:
declare interface ServerResponse {
    // Required to match external contract.
    // tslint:disable-next-line:enforce-name-casing
    error_code: number;
}

// Extending, implementing, or contextually matching the existing declaration
// is allowed to follow its naming convention without another suppression:
interface ErrorResponse extends ServerResponse {
    error_code: 400 | 500;
}

```



## 类型系统



### 类型推断

代码可以依赖 TypeScript 编译器对所有类型表达式（变量、字段、返回类型等）实现的类型推断。

```
const x = 15;  // Type inferred.

```

当类型可平凡推断时省略类型注解：初始化为 `string`、`number` 或 `boolean` 字面量的未导出变量或参数。在导出符号上，为与 `isolatedDeclarations` 兼容而需要时，类型注解不视为平凡。

```
let count: number = 0;  // Bad: type annotation here is redundant

// Bad: Exported interpolation fails isolatedDeclarations.
export const PATH = `/users/${id}`;

```

```
let count = 0;

// Good: Explicit type for isolatedDeclarations.
export const PATH: string = `/users/${id}`;

```

当显式泛型类型与类型注解冗余时，也省略它们。

```
// Bad: Specifying '<string>' twice is unnecessary.
const x: Set<string> = new Set<string>();

```

```
const x = new Set<string>();             // Preferred when local
export const y: Set<string> = new Set(); // Annotation required for exports

```

对更复杂的表达式，类型注解有助于程序可读性：

```
// Hard to reason about the type of 'value' without an annotation.
const value = await rpc.getSomeValue().transform();

```

```
// Can tell the type of 'value' at a glance.
const value: string[] = await rpc.getSomeValue().transform();

```

是否需要注解由代码审查者决定。

#### 返回类型

是否为函数与方法包含返回类型注解由代码作者决定。审查者可以要求注解以澄清难以理解的复杂返回类型。项目可以有始终要求返回类型的本地策略，但这不是通用 TypeScript 风格要求。

显式写出函数与方法的隐式返回值有两个好处：

- 更精确的文档，惠及代码读者。
- 若未来有改变函数返回类型的代码更改，能更快暴露潜在类型错误。



### undefined 与 null

TypeScript 支持 `undefined` 与 `null` 类型。可空类型可构造为联合类型（`string|null`）；`undefined` 同理。没有针对 `undefined` 与 `null` 联合的特殊语法。

TypeScript 代码可以用 `undefined` 或 `null` 表示值的缺失，没有优先其一的通用指导。许多 JavaScript API 使用 `undefined`（例如 `Map.get`），而许多 DOM 与 Google API 使用 `null`（例如 `Element.getAttribute`），因此合适的缺席值取决于上下文。

#### 可空/undefined 类型别名

类型别名禁止在联合类型中包含 `|null` 或 `|undefined`。可空别名通常表明 null 值正穿过应用的过多层，这模糊了导致 `null` 的原始问题来源。它们也使类或接口上特定值何时可能缺席变得不清楚。

改为，代码必须仅在实际使用别名处添加 `|null` 或 `|undefined`。代码应当在 null 值产生处附近处理它们，使用下列技术。

```
// Bad
type CoffeeResponse = Latte|Americano|undefined;

class CoffeeService {
    getLatte(): CoffeeResponse { ... };
}

```

```
// Better
type CoffeeResponse = Latte|Americano;

class CoffeeService {
    getLatte(): CoffeeResponse|undefined { ... };
}

```



### 使用结构化类型

TypeScript 的类型系统是结构化的，而非名义的。也就是说，若值至少具有类型要求的所有属性，且属性类型递归匹配，则该值匹配该类型。

提供基于结构的实现时，在符号声明处显式包含类型（这允许更精确的类型检查与错误报告）。

```
const foo: Foo = {
    a: 123,
    b: 'abc',
}

```

```
const badFoo = {
    a: 123,
    b: 'abc',
}

```

用接口定义结构化类型，而非类

```
interface Foo {
    a: number;
    b: string;
}

const foo: Foo = {
    a: 123,
    b: 'abc',
}

```

```
class Foo {
    readonly a: number;
    readonly b: number;
}

const foo: Foo = {
    a: 123,
    b: 'abc',
}

```

上面的 “badFoo” 对象依赖类型推断。可以向 “badFoo” 添加额外字段，类型根据对象本身推断。

当把 “badFoo” 传给接受 “Foo” 的函数时，错误会在函数调用点，而非对象声明点。在广泛代码库中更改接口表面时这也很有用。

```
interface Animal {
    sound: string;
    name: string;
}

function makeSound(animal: Animal) {}

/**
 * 'cat' has an inferred type of '{sound: string}'
 */
const cat = {
    sound: 'meow',
};

/**
 * 'cat' does not meet the type contract required for the function, so the
 * TypeScript compiler errors here, which may be very far from where 'cat' is
 * defined.
 */
makeSound(cat);

/**
 * Horse has a structural type and the type error shows here rather than the
 * function call.  'horse' does not meet the type contract of 'Animal'.
 */
const horse: Animal = {
    sound: 'niegh',
};

const dog: Animal = {
    sound: 'bark',
    name: 'MrPickles',
};

makeSound(dog);
makeSound(horse);

```



### 优先使用接口而非类型字面量别名

TypeScript 支持用类型别名为类型表达式命名。这可用于命名原始类型、联合、元组及任何其他类型。

但在为对象声明类型时，使用接口，而非对象字面量表达式的类型别名。

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

为什么？

这些形式几乎等价，因此在“两种形式中只选一种以防变异”的原则下，我们应当选一种。此外，还有有趣的技术理由优先使用接口。该页面引用 TypeScript 团队负责人：“Honestly, my take is that it should really just be interfaces for anything that they can model. There is no benefit to type aliases when there are so many issues around display/perf.”

### `Array<T>` 类型

对简单类型（仅含字母数字字符与点），使用数组的语法糖 `T[]` 或 `readonly T[]`，而非更长形式 `Array<T>` 或 `ReadonlyArray<T>`。

对简单类型的多维非 `readonly` 数组，使用语法糖形式（`T[][]`、`T[][][]` 等），而非更长形式。

对任何更复杂的情况，使用更长形式 `Array<T>`。

这些规则适用于每一层嵌套，即嵌套在更复杂类型中的简单 `T[]` 仍应拼写为 `T[]`，使用语法糖。

```
let a: string[];
let b: readonly string[];
let c: ns.MyObj[];
let d: string[][];
let e: Array<{n: number, s: string}>;
let f: Array<string|number>;
let g: ReadonlyArray<string|number>;
let h: InjectionToken<string[]>;  // Use syntax sugar for nested types.
let i: ReadonlyArray<string[]>;
let j: Array<readonly string[]>;

```

```
let a: Array<string>;  // The syntax sugar is shorter.
let b: ReadonlyArray<string>;
let c: Array<ns.MyObj>;
let d: Array<string[]>;
let e: {n: number, s: string}[];  // The braces make it harder to read.
let f: (string|number)[];         // Likewise with parens.
let g: readonly (string | number)[];
let h: InjectionToken<Array<string>>;
let i: readonly string[][];
let j: (readonly string[])[];

```



### 可索引类型 / 索引签名（`{[key: string]: T}`）

在 JavaScript 中，常用对象作为关联数组（亦称 “map”、“hash” 或 “dict”）。此类对象在 TypeScript 中可用索引签名（`[k: string]: T`）定型：

```
const fileSizes: {[fileName: string]: number} = {};
fileSizes['readme.txt'] = 541;

```

在 TypeScript 中，为键提供有意义的标签。（该标签仅用于文档；否则未使用。）

```
const users: {[key: string]: number} = ...;

```

```
const users: {[userName: string]: number} = ...;

```

> 与其使用这些，考虑改用 ES6 `Map` 与 `Set` 类型。JavaScript 对象有令人惊讶的不良行为，而 ES6 类型更明确地传达你的意图。此外，`Map` 可以用——且 `Set` 可以包含——`string` 以外的类型作为键。

TypeScript 内置的 `Record<Keys, ValueType>` 类型允许构造具有已定义键集的类型。这与关联数组不同，因为键是静态已知的。见下文相关建议。

### 映射类型与条件类型

TypeScript 的映射类型与条件类型允许基于其他类型指定新类型。TypeScript 标准库包含若干基于它们的类型运算符（`Record`、`Partial`、`Readonly` 等）。

这些类型系统特性允许简洁地指定类型，并构造强大且类型安全的抽象。但它们也有若干缺点：

- 与显式指定属性与类型关系相比（例如使用接口与扩展，见下文示例），类型运算符要求读者在脑中求值类型表达式。这会使程序显著更难读，尤其是与类型推断及跨文件表达式结合时。
- 映射与条件类型的求值模型，尤其与类型推断结合时，规范不足、并不总是被充分理解，且常随 TypeScript 编译器版本变化。代码可能“偶然”编译或看似给出正确结果。这会增加使用类型运算符的代码的未来维护成本。
- 映射与条件类型在从复杂和/或推断类型派生类型时最强大。另一方面，这也是它们最容易创建难以理解与维护的程序之时。
- 某些语言工具不能很好地处理这些类型系统特性。例如，IDE 的查找引用（因而属性重命名重构）找不到 `Pick<T, Keys>` 类型中的属性，Code Search 也不会为它们添加超链接。 *

风格建议是：

- 始终使用能表达你的代码的最简单类型构造。
- 一点重复或冗长往往远比复杂类型表达式的长期成本便宜。
- 映射与条件类型可以使用，但须受上述考虑约束。

例如，TypeScript 内置的 `Pick<T, Keys>` 类型允许通过子集化另一类型 `T` 创建新类型，但简单的接口扩展往往更易理解。

```
interface User {
    shoeSize: number;
    favoriteIcecream: string;
    favoriteChocolate: string;
}

// FoodPreferences has favoriteIcecream and favoriteChocolate, but not shoeSize.
type FoodPreferences = Pick<User, 'favoriteIcecream'|'favoriteChocolate'>;

```

这等价于在 `FoodPreferences` 上写出属性：

```
interface FoodPreferences {
    favoriteIcecream: string;
    favoriteChocolate: string;
}

```

为减少重复，`User` 可以扩展 `FoodPreferences`，或（可能更好）嵌套一个食物偏好字段：

```
interface FoodPreferences { /* as above */ }
interface User extends FoodPreferences {
    shoeSize: number;
    // also includes the preferences.
}

```

这里使用接口使属性分组显式、改善 IDE 支持、允许更好优化，并且可以说使代码更易理解。

### `any` 类型

TypeScript 的 `any` 类型是所有其他类型的超类型与子类型，并允许解引用所有属性。因此，`any` 是危险的——它可能掩盖严重的编程错误，其使用从根本上削弱了拥有静态类型的价值。

考虑不要使用 `any`。在想使用 `any` 的情形下，考虑下列之一：

- 提供更具体的类型
- 使用 `unknown`
- 抑制 lint 警告并记录原因



#### 提供更具体的类型

使用接口、内联对象类型或类型别名：

```
// Use declared interfaces to represent server-side JSON.
declare interface MyUserJson {
    name: string;
    email: string;
}

// Use type aliases for types that are repetitive to write.
type MyType = number|string;

// Or use inline object types for complex returns.
function getTwoThings(): {something: number, other: string} {
    // ...
    return {something, other};
}

// Use a generic type, where otherwise a library would say `any` to represent
// they don't care what type the user is operating on (but note "Return type
// only generics" below).
function nicestElement<T>(items: T[]): T {
    // Find the nicest element in items.
    // Code can also put constraints on T, e.g. <T extends HTMLElement>.
}

```



#### 使用 `unknown` 而非 `any`

`any` 类型允许赋值到任何其他类型，并从中解引用任何属性。通常这种行为并非必要或可取，代码只需要表达类型未知。在那种情况下使用内置类型 `unknown`——它表达该概念，且安全得多，因为它不允许解引用任意属性。

```
// Can assign any value (including null or undefined) into this but cannot
// use it without narrowing the type or casting.
const val: unknown = value;

```

```
const danger: any = value /* result of an arbitrary expression */;
danger.whoops();  // This access is completely unchecked!

```

要安全使用 `unknown` 值，使用类型守卫收窄类型

#### 抑制 `any` lint 警告

有时使用 `any` 是合理的，例如在测试中构造 mock 对象。在这种情况下，添加抑制 lint 警告的注释，并记录为何合理。

```
// This test only needs a partial implementation of BookService, and if
// we overlooked something the test will fail in an obvious way.
// This is an intentionally unsafe partial mock
// tslint:disable-next-line:no-any
const mockBookService = ({get() { return mockBook; }} as any) as BookService;
// Shopping cart is not used in this test
// tslint:disable-next-line:no-any
const component = new MyComponent(mockBookService, /* unused ShoppingCart */ null as any);

```



### `{}` 类型

`{}` 类型，亦称空接口类型，表示没有属性的接口。空接口类型没有指定属性，因此任何非 nullish 值都可赋值给它。

```
let player: {};

player = {
    health: 50,
}; // Allowed.

console.log(player.health) // Property 'health' does not exist on type '{}'.

```

```
function takeAnything(obj:{}) {

}

takeAnything({});
takeAnything({ a: 1, b: 2 });

```

Google3 代码在多数用例中不应使用 `{}`。`{}` 表示任何非 nullish 原始类型或对象类型，这很少合适。优先使用下列更具描述性的类型之一：

- `unknown` 可持有任何值，包括 `null` 或 `undefined`，对不透明值通常更合适。
- `Record<string, T>` 更适合字典类对象，并通过显式说明所含值的类型 `T`（其本身可以是 `unknown`）提供更好的类型安全。
- `object` 也排除原始类型，只留下非 nullish 函数与对象，但不对可能有哪些属性作其他假设。



### 元组类型

若你想创建 Pair 类型，改用元组类型：

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

// Use it like:
const [leftHalf, rightHalf] = splitInHalf('my string');

```

但通常为属性提供有意义的名称更清晰。

若声明 `interface` 过重，可以使用内联对象字面量类型：

```
function splitHostPort(address: string): {host: string, port: number} {
    ...
}

// Use it like:
const address = splitHostPort(userAddress);
use(address.port);

// You can also get tuple-like behavior using destructuring:
const {host, port} = splitHostPort(userAddress);

```



### 包装类型

有几种与 JavaScript 原始类型相关的类型永远不应使用：

- `String`、`Boolean` 与 `Number` 与对应的原始类型 `string`、`boolean` 与 `number` 含义略有不同。始终使用小写版本。
- `Object` 与 `{}` 和 `object` 都有相似之处，但略松一些。对包含除 `null` 与 `undefined` 外一切的类型使用 `{}`，或用小写 `object` 进一步排除其他原始类型（上述三种，加上 `symbol` 与 `bigint`）。

此外，禁止将包装类型作为构造函数调用（用 `new`）。

### 仅返回类型的泛型

避免创建仅有返回类型泛型的 API。使用已有仅返回类型泛型的 API 时，始终显式指定泛型。

## 工具链要求

Google 风格要求以特定方式使用若干工具，如下所述。

### TypeScript 编译器

所有 TypeScript 文件必须通过标准工具链的类型检查。

#### @ts-ignore

禁止使用 `@ts-ignore` 及其变体 `@ts-expect-error` 或 `@ts-nocheck`。

为什么？

它们表面上似乎是“修复”编译器错误的简单方法，但实践中，特定编译器错误往往由可更直接修复的更大问题引起。

例如，若你用 `@ts-ignore` 抑制类型错误，则很难预测周围代码最终会看到什么类型。对许多类型错误，如何最好地使用 `any` 中的建议很有用。

你可以在单元测试中使用 `@ts-expect-error`，但一般不应使用。`@ts-expect-error` 抑制所有错误。很容易意外过度匹配并抑制更严重的错误。考虑下列之一：

- 测试需要在运行时处理未检查值的 API 时，添加向期望类型或向 `any` 的强制转换，并加说明性注释。这将错误抑制限制在单个表达式。
- 抑制 lint 警告并记录原因，类似于抑制 `any` lint 警告。



### 一致性（Conformance）

Google TypeScript 包含若干一致性框架，tsetse 与 tsec。

这些规则常用于强制关键限制（例如定义全局变量，可能破坏代码库）与安全模式（例如使用 `eval` 或赋值给 `innerHTML`），或更宽松地用于提高代码质量。

Google 风格 TypeScript 必须遵守任何适用的全局或框架本地一致性规则。

## 注释与文档



#### JSDoc 与普通注释

有两种注释：JSDoc（`/** ... */`）与非 JSDoc 普通注释（`// ...` 或 `/* ... */`）。

- 对文档使用 `/** JSDoc */` 注释，即代码使用者应当阅读的注释。
- 对实现注释使用 `//` 行注释，即仅关乎代码本身实现的注释。

工具（如编辑器与文档生成器）理解 JSDoc 注释，而普通注释仅供其他人阅读。

#### 多行注释

多行注释与周围代码缩进同级。必须使用多个单行注释（`//` 风格），而非块注释风格（`/* */`）。

```
// This is
// fine

```

```
/*
 * This should
 * use multiple
 * single-line comments
 */

/* This should use // */

```

注释不用星号或其他字符画成的框包围。

### JSDoc 一般形式

JSDoc 注释的基本格式如本例所示：

```
/**
 * Multiple lines of JSDoc text are written here,
 * wrapped normally.
 * @param arg A number to do something to.
 */
function doSomething(arg: number) { … }

```

或如下单行示例：

```
/** This short jsdoc describes the function. */
function doSomething(arg: number) { … }

```

若单行注释溢出为多行，必须使用多行风格，`/**` 与 `*/` 各自独占一行。

许多工具从 JSDoc 注释提取元数据以执行代码验证与优化。因此，这些注释必须格式良好。

### Markdown

JSDoc 用 Markdown 书写，必要时可以包含 HTML。

这意味着解析 JSDoc 的工具会忽略纯文本格式，因此若你这样写：

```
/**
 * Computes weight based on three factors:
 *   items sent
 *   items received
 *   last timestamp
 */

```

会渲染成这样：

```
Computes weight based on three factors: items sent items received last timestamp

```

改为写 Markdown 列表：

```
/**
 * Computes weight based on three factors:
 *
 * - items sent
 * - items received
 * - last timestamp
 */

```



### JSDoc 标签

Google 风格允许 JSDoc 标签的一个子集。多数标签必须独占一行，标签位于行首。

```
/**
 * The "param" tag must occupy its own line and may not be combined.
 * @param left A description of the left param.
 * @param right A description of the right param.
 */
function add(left: number, right: number) { ... }

```

```
/**
 * The "param" tag must occupy its own line and may not be combined.
 * @param left @param right
 */
function add(left: number, right: number) { ... }

```



### 换行

换行的块标签缩进四个空格。换行的描述文本可以与前一行描述对齐，但不鼓励这种水平对齐。

```
/**
 * Illustrates line wrapping for long param/return descriptions.
 * @param foo This is a param with a particularly long description that just
 *     doesn't fit on one line.
 * @return This returns something that has a lengthy description too long to fit
 *     in one line.
 */
exports.method = function(foo) {
    return 5;
};

```

换行 `@desc` 或 `@fileoverview` 描述时不要缩进。

### 为模块所有顶层导出编写文档

使用 `/** JSDoc */` 注释向代码使用者传达信息。避免仅仅重述属性或参数名。你也应当为名称不能立即表明用途的所有属性与方法（无论是否导出/公有）编写文档，由审查者判断。

例外：仅为工具消费而导出的符号（如 @NgModule 类）不需要注释。

### 类注释

类的 JSDoc 注释应当为读者提供足够信息，以了解如何以及何时使用该类，以及正确使用该类所需的任何额外考虑。构造函数上可以省略文字描述。

### 方法与函数注释

若从方法其余 JSDoc 或从方法名与类型签名显而易见，可以省略方法、参数与返回描述。

方法描述以描述该方法做什么的动词短语开头。该短语不是祈使句，而是用第三人称书写，仿佛前面隐含 “This method …”。

### 参数属性注释

参数属性是带有修饰符 `private`、`protected`、`public` 或 `readonly` 之一前缀的构造函数参数。参数属性同时声明参数与实例属性，并隐式赋值。例如，`constructor(private readonly foo: Foo)` 声明构造函数接受参数 `foo`，但也声明私有只读属性 `foo`，并在执行构造函数其余部分之前将参数赋给该属性。

要为这些字段编写文档，使用 JSDoc 的 `@param` 注解。编辑器会在构造函数调用与属性访问时显示描述。

```
/** This class demonstrates how parameter properties are documented. */
class ParamProps {
    /**
   * @param percolator The percolator used for brewing.
   * @param beans The beans to brew.
   */
    constructor(
    private readonly percolator: Percolator,
    private readonly beans: CoffeeBean[]) {}
}

```

```
/** This class demonstrates how ordinary fields are documented. */
class OrdinaryClass {
    /** The bean that will be used in the next call to brew(). */
    nextBean: CoffeeBean;

    constructor(initialBean: CoffeeBean) {
        this.nextBean = initialBean;
    }
}

```



### JSDoc 类型注解

在 TypeScript 源码中，JSDoc 类型注解是冗余的。禁止在 `@param` 或 `@return` 块中声明类型，禁止在使用 `implements`、`enum`、`private`、`override` 等关键字的代码上写 `@implements`、`@enum`、`@private`、`@override` 等。

### 编写真正增加信息的注释

对非导出符号，有时函数或参数的名称与类型就足够了。不过代码通常会从比仅有变量名更多的文档中受益！

- 避免仅仅重述参数名与类型的注释，例如

```
/** @param fooBarService The Bar service for the Foo application. */

```

- 因此，仅当 `@param` 与 `@return` 行增加信息时才需要，否则可以省略。

```
/**
 * POSTs the request to start coffee brewing.
 * @param amountLitres The amount to brew. Must fit the pot size!
 */
brew(amountLitres: number, logger: Logger) {
    // ...
}

```



#### 调用函数时的注释

每当方法名与参数值不足以传达参数含义时，应当使用“参数名”注释。

在添加这些注释之前，考虑将方法重构为接受接口并解构它，以大幅改善调用点可读性。

“参数名”注释放在参数值之前，包含参数名与 `=` 后缀：

```
someFunction(obviousParam, /* shouldRender= */ true, /* name= */ 'hello');

```

既有代码可能使用遗留的参数名注释风格，将这些注释放在参数值~之后~并省略 `=`。为一致性在文件内继续使用此风格是可接受的。

```
someFunction(obviousParam, true /* shouldRender */, 'hello' /* name */);

```



### 将文档放在装饰器之前

当类、方法或属性同时有如 `@Component` 的装饰器与 JsDoc 时，请确保将 JsDoc 写在装饰器之前。

- 禁止在装饰器与被装饰语句之间写 JsDoc。

```
@Component({
    selector: 'foo',
    template: 'bar',
})
/** Component that prints "bar". */
export class FooComponent {}

```

- 将 JsDoc 块写在装饰器之前。

```
/** Component that prints "bar". */
@Component({
    selector: 'foo',
    template: 'bar',
})
export class FooComponent {}

```



## 策略



### 一致性

对本规范未明确解决的任何风格问题，按同一文件中其他代码已在做的去做（“保持一致”）。若这仍不能解决问题，考虑效仿同一目录中的其他文件。

全新文件必须使用 Google 风格，无论同一包中其他文件的风格选择如何。向非 Google 风格的文件添加新代码时，建议先按下文建议重新格式化既有代码。若未做此重新格式化，则新代码应尽可能与同一文件中的既有代码一致，但禁止违反风格指南。

#### 重新格式化既有代码

你偶尔会遇到代码库中不符合正确 Google 风格的文件。它们可能来自收购，或可能在 Google 风格对某些问题表态之前写成，或可能因任何其他原因而非 Google 风格。

更新既有代码的风格时，遵循下列指南。

1. 不要求将所有既有代码改为符合当前风格指南。重新格式化既有代码是代码扰动与一致性之间的权衡。风格规则随时间演进，为保持合规而做这类微调会造成不必要的扰动。但若对文件做重大更改，则期望该文件符合 Google 风格。
2. 小心不要让机会主义的风格修复搅乱 CL 的焦点。若你发现自己做了大量对 CL 中心焦点非关键的风格更改，将这些更改提升为单独的 CL。



### 弃用

用 `@deprecated` JSDoc 注解标记弃用的方法、类或接口。弃用注释必须包含简单、清晰的说明，指导人们修复其调用点。

### 生成的代码：大体豁免

构建过程生成的源代码不要求符合 Google 风格。但任何将从手写源代码引用的生成标识符必须遵循命名要求。作为特殊例外，此类标识符允许包含下划线，这可能有助于避免与手写标识符冲突。

#### 风格指南目标

总体上，工程师通常最了解其代码需要什么，因此若有多个选项且选择取决于具体情况，我们应当让决策在本地做出。因此默认答案应当是“不要写进指南”。

下列几点是例外，也是我们有一些全局规则的原因。对照下列评估你的风格指南提案：

1. 代码应当避免已知会导致问题的模式，尤其对语言新手。
2. 跨项目的代码应当在无关紧要的变体上保持一致。

当两种选项在表面上等价时，我们应当考虑只选一种，以免无故分歧演进，并避免代码审查中的无意义争论。

示例：

- 名称的大小写风格。
- `x as T` 语法与等价的  `x` 语法（禁止）。
- `Array<[number, number]>` 与 `[number, number][]`。

1. 代码应当可长期维护。

代码通常比原作者在其上工作的时间更长，TypeScript 团队必须让 Google 的一切在未来继续运转。

示例：

- 我们用软件自动更改代码，因此代码自动格式化，便于软件满足空白规则。
- 我们要求单一编译器标志集，以便给定 TS 库可在假定特定标志集的情况下编写，使用者始终可以安全使用共享库。
- 代码必须导入它所使用的库（“严格依赖”），以便依赖中的重构不会改变其使用者的依赖。
- 我们要求使用者编写测试。没有测试，我们无法确信我们对语言所做的更改不会破坏使用者。

1. 代码审查者应当专注于提高代码质量，而非强制执行任意规则。

若有可能将你的规则实现为自动检查，这往往是好兆头。这也支持原则 3。

若它真的不那么重要——若它是语言的冷僻角落，或避免的是不太可能发生的缺陷——可能值得不写进指南。

1. 命名空间导入常被称为 ‘module imports’ ↩
2. 具名导入有时被称为 ‘destructuring imports’，因为它们使用与解构赋值类似的语法。 ↩

