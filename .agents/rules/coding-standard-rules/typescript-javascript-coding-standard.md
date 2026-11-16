# TypeScript and JavaScript coding standard

## 引言

### 术语说明

本风格指南在使用 must、must not、should、should not 和 may 时采用 RFC 2119 的术语。prefer 和 avoid 分别对应 should 和 should not。祈使句和陈述句是规定性的，对应 must。

### 指南说明

所给示例都不是规范性的，只用来说明风格指南的规范性文字。也就是说，虽然示例采用 Google 风格，它们未必展示了表示这段代码的唯一得体方式。示例中的可选格式选择不得被当作规则强制执行。


## VeriQ 格式规则

这些规则是规范性的，与 Google 原文不一致时以这里为准。

- 块使用 4 个空格缩进。禁止使用 Tab。嵌套块每层增加 4 个空格。续行可以与开分隔符对齐，或相对语句起点悬挂缩进 4 个空格。
- 代码行最多 120 个字符，与 Prettier 的 `printWidth` 120 一致。
- 普通字符串字面量使用双引号，与 Prettier 的 `singleQuote: false` 一致。见字符串字面量一节。
- 注释和 JSDoc 使用中文。注释块的第一行至少 40 个字符。每一行注释最多 80 个字符，超出部分换行。
- 产品名 VeriQ 和技术标识可以在中文注释里保持原文。


## 源文件基础

### 文件编码：UTF-8

源文件使用 UTF-8 编码。

#### 空白字符

除行终止序列外，ASCII 水平空格字符（0x20）是源文件中唯一出现的空白字符。这意味着字符串字面量中的所有其他空白字符都要转义。

#### 特殊转义序列

对任何有特殊转义序列的字符（`\'`、`\"`、`\\ `、`\b`、`\f`、`\n`、`\r`、`\t`、`\v`），使用该序列，而不是对应的数字转义（例如 `\x0a`、`\u000a` 或 `\u{a}`）。绝不使用旧式八进制转义。

#### 非 ASCII 字符

对其余非 ASCII 字符，使用实际的 Unicode 字符（例如 `∞`）。对不可打印字符，可以使用等价的十六进制或 Unicode 转义（例如 `\u221e`），并附上说明性注释。

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

## 源文件结构

文件按下列顺序组成：

1. 版权信息，如果有
2. 带 `@fileoverview` 和/或其他文件级 JSDoc 标签的 JSDoc，如果有
3. 导入，如果有
4. 文件的实现

每个存在的节之间恰好空一行。

### 版权信息

如果文件需要许可证或版权信息，把它加在文件顶部的 JSDoc 里。

### `@fileoverview` JSDoc

文件可以有顶层的 `@fileoverview` JSDoc。如果有，它可以描述文件内容、用途，或关于其依赖的信息。换行后的行不要缩进。

示例：

```
/**
 * 文件概览要写这个模块负责什么、谁会导入它，不要用占位的拉丁文把概览凑长，本例就是这样。
 *
 * 换行后的概览不要再缩进，保持和第一行说明同一列。
 */

```

### 导入

ES6 和 TypeScript 中有四种导入语句：

| 导入类型 | 示例 | 用于 |
| --- | --- | --- |
| 模块 1 | `import * as foo from "...";` | TypeScript 导入 |
| 具名 2 | `import {SomeThing} from "...";` | TypeScript 导入 |
| 默认 | `import SomeThing from "...";` | 仅用于其他要求默认导入的外部代码 |
| 副作用 | `import "...";` | 仅用于导入加载时产生副作用的库（例如自定义元素） |

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

#### 导入路径

TypeScript 代码必须使用路径来导入其他 TypeScript 代码。路径可以是相对的，即以 `.` 或 `..` 开头，也可以根植于基目录，例如 `root/path/to/file`。

引用同一（逻辑）项目内的文件时，代码应使用相对导入（`./foo`），而不是绝对导入 `path/to/foo`，因为这样移动项目时不必改这些导入。

考虑限制父级步数（`../../../`），因为它们会让模块和路径结构难以理解。

```
import {Symbol1} from "path/from/root";
import {Symbol2} from "../parent/file";
import {Symbol3} from "./sibling";

```

#### 命名空间导入与具名导入

命名空间导入和具名导入都可以使用。

对文件中频繁使用的符号，或名字清楚的符号，优先使用具名导入，例如 Jasmine 的 `describe` 和 `it`。需要时可以用 `as` 把具名导入改成更清楚的名字。

从大型 API 使用许多不同符号时，优先使用命名空间导入。命名空间导入虽然使用 `*` 字符，但并不能与其他语言中的“通配”导入相比。命名空间导入给模块的全部导出起一个名字，模块的每个导出符号都成为该模块名上的一个属性。对 `Model` 或 `Controller` 这类常见名字的导出符号，命名空间导入可以提高可读性，而不必声明别名。

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

##### 特例：Apps JSPB proto

Apps JSPB proto 必须使用具名导入，即使这会导致很长的导入行。

这条规则是为了帮助构建性能和死代码消除，因为 `.proto` 文件常常包含许多并不一起需要的 `message`。利用解构导入，构建系统可以在保持基于路径的导入手感的同时，对 Apps JSPB 消息建立更细粒度的依赖。

```
// 从 proto 文件只导入这次用到的消息，构建才能按消息裁剪，而不是把整份 proto 拉进来。
import {Foo, Bar} from "./foo.proto";

function copyFooBar(foo: Foo, bar: Bar) {...}

```

#### 重命名导入

代码应通过命名空间导入或重命名导出本身来解决名字冲突。需要时可以重命名导入（`import {SomeThing as SomeOtherThing}`）。

重命名有帮助的三个例子：

1. 必须避免与其他导入符号冲突时。
2. 导入的符号名是生成的。
3. 如果导入的符号本身名字不清楚，重命名可以提高代码清晰度。例如使用 RxJS 时，把 `from` 函数重命名为 `observableFrom` 可能更可读。

### 导出

所有代码都使用具名导出：

```
// 模块使用具名导出，导入方必须写出同一个名字，重命名不会悄悄指向另一份实现，本例就是这样。
export class Foo { ... }

```

不要使用默认导出。这样可以确保所有导入遵循同一种模式。

```
// 不要使用默认导出。默认导出名由导入方随意起，重构时无法靠名字找到全部调用点，本例就是这样。
// 这是被禁止的默认导出。导入方可以把它叫成任何名字，模块自己的名字因此丢失，本例就是这样。
export default class Foo { ... }

```

为什么？

默认导出不提供规范名字，这使集中维护变得困难，而对代码所有者的好处相对很少，还可能降低可读性：

```
import Foo from "./bar";  // 默认导出允许导入方自选本地名，两个不同的名字可以指向同一个模块里的同一个类，本例就是这样。
import Bar from "./bar";  // 另一个导入方把同一默认导出叫成别的名字，阅读调用点时无法知道它们是同一个类，本例就是这样。

```

具名导出的好处是：导入语句试图导入尚未声明的东西时会报错。在 `foo.ts` 中：

```
const foo = "blah";
export default foo;

```

而在 `bar.ts` 中：

```
import {fizz} from "./foo";

```

得到 `error TS2614: Module "./foo" has no exported member 'fizz'.` 而 `bar.ts`：

```
import fizz from "./foo";

```

得到 `fizz === foo`，这可能出人意料，也难以调试。

此外，默认导出鼓励人们把一切放进一个大对象里，以便一起做命名空间：

```
export default class Foo {
    static SOME_CONSTANT = ...
    static someHelpfulFunction() { ... }
    ...
}

```

按上面的模式，我们有文件作用域，它可以用作命名空间。我们还有一个也许不必要的第二作用域（类 `Foo`），它在其他文件里可以含糊地既当作类型又当作值。

应优先用文件作用域做命名空间，并使用具名导出：

```
export const SOME_CONSTANT = ...
export function someHelpfulFunction()
export class Foo {
    // 这个类体只放属于类的成员，文件里的其他函数不要塞进类里，免得实例上出现无用字段。
}

```

#### 导出可见性

TypeScript 不支持限制已导出符号的可见性。只导出模块外部会使用的符号。一般应尽量缩小模块导出的 API 表面。

#### 可变导出

无论技术上是否支持，可变导出都会制造难以理解和调试的代码，尤其是跨多个模块再导出时。可以把这条风格要点转述为：不允许 `export let`。

```
export let foo = 3;
// 纯 ES6 里导入方能看到 foo 在一秒后变成 4。若另一个文件再导出它，TypeScript 的导入方看不到这次修改。
window.setTimeout(() => {
    foo = 4;
// 延时的单位是毫秒。只写 1000 时，读者无法判断 setTimeout 的第二个参数是秒还是毫秒。
}, 1000);

```

如果需要支持外部可访问且可变的绑定，应改用显式的读取函数。

```
let foo = 3;
window.setTimeout(() => {
    foo = 4;
// 延时的单位是毫秒。只写 1000 时，读者无法判断 setTimeout 的第二个参数是秒还是毫秒。
}, 1000);
// 可变状态留在模块内部，对外只提供读取函数，导入方就不会依赖一个随后会变的绑定，本例就是这样。
export function getFoo() { return foo; };

```

对有条件地导出两个值之一这种常见模式，先做条件判断，再导出。确保模块主体执行完毕后，所有导出都是最终的。

```
function pickApi() {
    if (useOtherApi()) return OtherApi;
    return RegularApi;
}
export const SomeApi = pickApi();

```

#### 容器类

不要为了做命名空间而创建带静态方法或静态属性的容器类。

```
export class Container {
    static FOO = 1;
    static bar() { return 1; }
}

```

应导出单独的常量和函数：

```
export const FOO = 1;
export function bar() { return 1; }

```

### 导入类型与导出类型

#### 导入类型

当导入的符号只当作类型使用时，可以使用 `import type {...}`。值使用普通导入：

```
import type {Foo} from "./foo";
import {Bar} from "./foo";

import {type Foo, Bar} from "./foo";

```

TypeScript 编译器会自动处理这种区分，不会为类型引用插入运行时加载。那么为什么还要标注类型导入？

TypeScript 编译器可以在两种模式下运行：

- 在开发模式中，我们通常想要快速的迭代循环。编译器在没有完整类型信息的情况下转译成 JavaScript。这快得多，但在某些情况下需要 `import type`。
- 在生产模式中，我们想要正确性。编译器检查一切，并确保 `import type` 被正确使用。

注意：如果需要强制为副作用做运行时加载，使用 `import "...";`。见导入一节。

#### 导出类型

再导出类型时使用 `export type`，例如：

```
export type {AnInterface} from "./foo";

```

`export type` 有助于在逐文件转译中再导出类型。见 `isolatedModules` 文档。

`export type` 看起来也可以用来避免为某个 API 导出值符号。但它同样不提供保证：下游代码仍可能通过另一条路径导入该 API。把 API 的类型用法和值用法拆开并加以保证的更好办法，是真的把符号拆成例如 `UserService` 和 `AjaxUserService`。这样更不容易出错，也更好地表达意图。

#### 动态 `import()` 类型

不要在类型注解里使用 `import()` 函数。

```
let f: import("./foo").Foo;

```

如果需要确保该导入始终从生成的 JavaScript 中被删掉，改用 `import type`。

```
import type {Foo} from "./foo";

```

#### 使用模块，不要使用命名空间

TypeScript 支持两种组织代码的方法：命名空间和模块，但不允许使用命名空间。也就是说，代码必须用 `import {foo} from "bar";` 这种形式的导入和导出来引用其他文件中的代码。

代码不得使用 `namespace Foo { ... }` 构造。只有在必须与外部第三方代码对接时才可以使用 `namespace`。要用语义上的命名空间组织代码，使用单独的文件。

代码不得使用 `require`（如 `import x = require("...");`）来导入。使用 ES6 模块语法。

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

> 注意：TypeScript 的 `namespace` 以前称为内部模块，并使用 `module Foo { ... }` 这种形式的 `module` 关键字。那也不要使用。始终使用 ES6 导入。

## 语言特性

本节说明哪些特性可以使用、哪些不可以使用，以及对它们的使用还有哪些额外约束。

本风格指南没有讨论的语言特性可以使用，对其用法不作推荐。

### 局部变量声明

#### 使用 const 和 let

始终用 `const` 或 `let` 声明变量。默认使用 `const`，除非变量需要被重新赋值。绝不要使用 `var`。

```
const foo = otherValue;  // foo 在初始化之后不再赋值，所以用 const，读者可以把它当成这份模块里的稳定绑定。
let bar = someValue;  // bar 后面还会被重新赋值，必须用 let，不能为了省事写成初始化之后不能再改的 const。

```

`const` 和 `let` 是块作用域的，和大多数其他语言中的变量一样。JavaScript 中的 `var` 是函数作用域的，会造成难以理解的缺陷。不要使用它。

```
var foo = someValue;  // 不要用 var。它是函数作用域，会在块外仍然可见，这种提升经常引入难以定位的赋值错误。

```

变量不得在声明之前使用。

#### 每个声明一个变量

每条局部变量声明只声明一个变量：不使用 `let a = 1, b = 2;` 这种声明。

### 数组字面量

#### 不要使用 `Array` 构造函数

不要使用 `Array()` 构造函数，无论有没有 `new`。它的用法令人困惑且自相矛盾：

```
const a = new Array(2);  // 用数组构造函数只传入长度时，得到的是空槽，不是两个已经放好的元素，遍历结果会不同。
const b = new Array(2, 3);  // 传入两个数字时，数组构造函数把它们当成元素，而不是按其中一个数字预分配长度，本例就是这样。

```

应始终用方括号记法初始化数组，或用 `from` 初始化特定大小的 `Array`：

```
const a = [2];
const b = [2, 3];

// 先建空数组再改 length，效果和只传长度的构造函数一样，数组里留下的仍是空槽。
const c = [];
c.length = 2;

// 需要固定长度的零填充数组时，用 Array.from 再 fill，不要依赖构造函数的长度参数。
Array.from<number>({length: 5}).fill(0);

```

#### 不要在数组上定义属性

不要在数组上定义或使用非数字属性（`length` 除外）。改用 `Map`（或 `Object`）。

#### 数组解构

赋值左侧可以使用数组字面量来做解构（例如从一个数组或可迭代对象中拆出多个值）。可以包含最后一个“剩余”元素（`...` 与变量名之间没有空格）。未使用的元素应当省略。

```
const [a, b, c, ...rest] = generateResults();
let [, b,, d] = someArray;

```

解构也可以用于函数参数。如果解构的数组参数是可选的，始终把 `[]` 指定为默认值，并在左侧提供默认值：

```
function destructured([a = 4, b = 2] = []) { … }

```

不允许：

```
function badDestructuring([a, b] = [4, 2]) { … }

```

提示：把多个值装进或拆出函数的参数或返回值时，尽可能优先使用对象解构而不是数组解构，因为它允许给各个元素命名，并为每个元素指定不同的类型。

### 对象字面量

#### 不要使用 `Object` 构造函数

不允许使用 `Object` 构造函数。改用对象字面量（`{}` 或 `{a: 0, b: 1, c: 2}`）。

#### 迭代对象

用 `for (... in ...)` 迭代对象容易出错。它会包含原型链上的可枚举属性。

不要使用未过滤的 `for (... in ...)` 语句：

```
for (const x in someObj) {
    // for-in 会走到原型链上的可枚举属性，循环变量不一定是这个对象自己定义的键。
}

```

要么用 `if` 语句显式过滤值，要么使用 `for (... of Object.keys(...))`。

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

#### 使用展开语法

使用展开语法 `{...bar}` 是创建对象浅拷贝的方便简写。在对象初始化中使用展开语法时，同一键上后面的值会替换前面的值。

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

避免展开原型不是 Object 原型的对象（例如类定义、类实例、函数），因为行为不直观（只浅拷贝可枚举的、非原型属性）。

```
// 把数组展开进对象会得到下标键，结果没有 length，之后不能再把它当成数组来用。
const fooStrings = ["a", "b", "c"];
const ids = {...fooStrings};

```

```
const options = {foo: 1, bar: 2};
const extended = {...options, baz: 3};

```

#### 计算属性名

允许计算属性名（例如 `{["key" + foo()]: 42}`），它们被视为字典式（加引号的）键（也就是不得与不加引号的键混用），除非计算属性是符号（例如 `[Symbol.iterator]`）。

#### 对象解构

赋值左侧可以使用对象解构模式来做解构，从一个对象中拆出多个值。

解构的对象也可以用作函数参数，但应尽量保持简单：只有一层不加引号的简写属性。参数解构中不得使用更深的嵌套和计算属性。在解构参数的左侧指定任何默认值（`{str = "some default"} = {}`，而不是 `{str} = {str: "some default"}`）；如果解构的对象本身是可选的，它必须默认为 `{}`。

示例：

```
interface Options {
    /** 这个可选数字表示同一操作要重复的次数，不传时由调用方的默认逻辑决定重复几次，本例就是这样。 */
    num?: number;

    /** 这个可选字符串是被处理的文本，缺省时使用参数初始化器里的默认文本，而不是空串，本例就是这样。 */
    str?: string;
}

function destructured({num, str = "default"}: Options = {}) {}

```

不允许：

```
function nestedTooDeeply({x: {num, str}}: {x: Options}) {}
function nontrivialDefault({num, str}: Options = {num: 42, str: "default"}) {}

```

### 类

#### 类声明

类声明不得以分号结尾：

```
class Foo {
}

```

```
class Foo {
};  // 类声明本身不是语句，末尾的分号是多余的，应删掉，以免看起来像紧跟着另一条语句，本例就是这样。

```

相反，包含类表达式的语句必须以分号结尾：

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

类声明的花括号与其他类内容之间是否用空行隔开，既不鼓励也不反对：

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

#### 不要创建只在构造函数中使用的成员变量

如果一个变量只在构造函数中使用，就可以把它改成构造函数体作用域内的变量，这会让类更无状态，也让后来的开发者更容易推理。

有些类有只在构造函数中调用的方法，它们更新的那部分类状态也只在类构造期间使用。出于与上面相同的原因，这些类状态也应改成构造函数的局部变量。

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

#### 类方法声明

类方法声明不得用分号分隔各个方法声明：

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

方法声明应与周围代码用一个空行隔开：

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

可以覆盖 `toString` 方法，但它必须始终成功，并且不得有可见的副作用。

提示：尤其要小心从 toString 调用其他方法，因为异常情况可能导致无限循环。

#### 静态方法

##### 避免私有静态方法

在不影响可读性的地方，优先使用模块局部函数，而不是私有静态方法。

##### 不要依赖动态分派

代码不应依赖静态方法的动态分派。静态方法只应在定义它的基类本身上调用。不应在可能是构造函数或子类构造函数的动态实例变量上调用静态方法（如果这样做，必须用 `@nocollapse` 定义），也不得直接在自己没有定义该方法的子类上调用。

不允许：

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

##### 避免静态的 `this` 引用

代码不得在静态上下文中使用 `this`。

JavaScript 允许通过 `this` 访问静态字段。与其他语言不同，静态字段也会被继承。

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

为什么？

这段代码通常令人意外：作者可能没想到可以通过 this 指针访问静态字段，也可能惊讶地发现它们可以被覆盖——这个特性并不常用。

这段代码还鼓励大量静态状态这种反模式，会给可测试性带来问题。

#### 构造函数

构造函数调用必须使用圆括号，即使不传递参数：

```
const x = new Foo;

```

```
const x = new Foo();

```

省略圆括号会导致细微错误。下面两行并不等价：

```
new Foo().Bar();
new Foo.Bar();

```

不必提供空构造函数，或只是委托给父类的构造函数，因为如果没有指定，ES2015 会提供默认类构造函数。不过，带参数属性、可见性修饰符或参数装饰器的构造函数即使函数体为空也不应省略。

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

构造函数上下都应与周围代码用一个空行隔开：

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

##### 不要使用 #private 字段

不要使用私有字段（也称为私有标识符）：

```
class Clazz {
    #ident = 1;
}

```

应使用 TypeScript 的可见性注解：

```
class Clazz {
    private ident = 1;
}

```

私有标识符在被 TypeScript 降级时会造成明显的输出体积和性能回退，并且在 ES2015 之前不受支持。它们只能降级到 ES2015，不能更低。同时，当用静态类型检查来强制可见性时，它们并没有实质性好处。

##### 使用 readonly

对构造函数之外不再重新赋值的属性，用 `readonly` 修饰符标记（它们不必是深度不可变的）。

##### 参数属性

不要把一个显而易见的初始化值再接到类成员上，使用 TypeScript 参数属性。

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

如果参数属性需要文档，使用 `@param` JSDoc 标签。

##### 字段初始化器

如果初始化类成员不依赖构造函数参数或参数属性，就在声明它的地方初始化。这有时让你可以完全去掉构造函数。

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

由于 TypeScript 把这种模式转译成 JavaScript 的方式，可以从字段初始化器引用参数属性。这种转译正在改变以匹配 JavaScript 语言语义，从字段初始化器引用参数属性将成为 TypeScript 编译器错误，因此应避免这种模式。

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

提示：构造函数结束后，绝不要再向实例添加或移除属性，因为这会严重妨碍虚拟机优化类的“形状”。以后可能填上的可选字段应显式初始化为 `undefined`，以防止以后的形状变化。

##### 在类词法作用域之外使用的属性

从其包含类的词法作用域之外使用的属性，不得使用 `private` 可见性，因为它们用在包含类的词法作用域之外。

例外：只从模板使用的 Angular 组件属性允许使用 `private` 可见性。

对该属性使用合适的 `protected` 或 `public`。

TypeScript 代码不得使用 `obj["foo"]` 来绕过属性的可见性。

为什么？

当属性是 `private` 时，你是在向自动化系统和人声明：对该属性的访问限定在声明类的方法里，它们会依赖这一点。例如，未使用代码检查会把看起来未使用的私有属性标出来，即使另一个文件设法绕过了可见性限制。

虽然看起来 `obj["foo"]` 可以在 TypeScript 编译器里绕过可见性，这种模式会因调整构建规则而失效，也违反优化兼容性。

##### 读取器与设置器

可以使用类成员的读取器和设置器，也称为访问器。读取器方法必须是纯函数（也就是结果一致且没有副作用：读取器不得改变可观察状态）。它们也有助于限制内部或冗长实现细节的可见性（如下所示）。

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

如果用访问器隐藏类属性，被隐藏的属性可以用任意完整单词作前缀或后缀，例如 `internal` 或 `wrapped`。使用这些私有属性时，尽可能通过访问器取值。一个属性至少要有一个并非平凡的访问器：不要只为了隐藏属性而定义“直通”访问器。应把属性公开（或考虑把它做成 `readonly`，而不是只定义没有设置器的读取器）。

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

不得用 `Object.defineProperty` 定义读取器和设置器，因为这会干扰属性重命名。

##### 计算属性

只有当属性是符号时，类中才可以使用计算属性。不允许字典式属性（也就是加引号的或计算的非符号键）。对逻辑上可迭代的任何类，都应定义 `[Symbol.iterator]` 方法。除此之外，应少用 `Symbol`。

提示：小心使用任何其他内置符号（例如 `Symbol.isConcatSpreadable`），因为编译器不会给它们做 polyfill，因此在较旧的浏览器中不会工作。

#### 可见性

限制属性、方法和整个类型的可见性有助于保持代码解耦。

- 尽可能限制符号可见性。
- 考虑把私有方法转换成同一文件中、任何类之外的非导出函数，并把私有属性移到单独的、非导出的类里。
- TypeScript 符号默认是公开的。除了声明非只读的公开参数属性（在构造函数中）之外，绝不要使用 `public` 修饰符。

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

#### 不允许的类模式

##### 不要直接操作 `prototype`

`class` 关键字提供的类定义比定义 `prototype` 属性更清楚、更可读。普通实现代码没有理由操作这些对象。明确禁止混入以及修改内置对象的原型。

例外：框架代码（例如 Polymer 或 Angular）可能需要使用 `prototype`，不应为了避免这样做而采取更糟的变通办法。

### 函数

#### 术语

函数有许多不同类型，它们之间有细微差别。本指南使用下列术语，与 MDN 一致：

- “函数声明”：使用 `function` 关键字的声明（也就是不是表达式）
- “函数表达式”：使用 `function` 关键字的表达式，通常用于赋值或作为参数传递
- “箭头函数”：使用 `=>` 语法的表达式
- “块体”：带花括号的箭头函数右侧
- “简洁体”：不带花括号的箭头函数右侧

本节不讨论方法和类/构造函数。

#### 具名函数优先使用函数声明

定义具名函数时，优先使用函数声明，而不是箭头函数或函数表达式。

```
function foo() {
    return 42;
}

```

```
const foo = () => 42;

```

例如当需要显式类型注解时，可以使用箭头函数。

```
interface SearchFunction {
    (source: string, subString: string): boolean;
}

const fooSearch: SearchFunction = (source, subString) => { ... };

```

#### 嵌套函数

嵌套在其他方法或函数中的函数可以视情况使用函数声明或箭头函数。特别是在方法体里，优先使用箭头函数，因为它们可以访问外层的 `this`。

#### 不要使用函数表达式

不要使用函数表达式。改用箭头函数。

```
bar(() => { this.doSomething(); })

```

```
bar(function() { ... })

```

例外：只有当代码必须动态重新绑定 `this`（但不鼓励这样做），或用于没有箭头语法的生成器函数时，才可以使用函数表达式。

#### 箭头函数体

视情况使用带简洁体（即表达式）或块体的箭头函数。

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

只有当函数的返回值真的被使用时，才使用简洁体。块体此时确保返回类型是 `void`，并防止潜在的副作用。

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

提示：当结果未被使用时，可以用 `void` 运算符确保带表达式体的箭头函数返回 `undefined`。

#### 重新绑定 `this`

函数表达式和函数声明不得使用 `this`，除非它们专门用来重新绑定 `this` 指针。多数情况下可以用箭头函数或显式参数避免重新绑定 `this`。

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

优先使用箭头函数，而不是其他绑定 `this` 的办法，例如 `f.bind(this)`、`goog.bind(f, this)` 或 `const self = this`。

#### 优先把箭头函数作为回调传递

回调可能被用出人意料的参数调用，这些参数能通过类型检查，但仍造成逻辑错误。

除非你确信两个函数的调用签名都稳定，否则避免把具名回调传给高阶函数。尤其要小心较少使用的可选参数。

```
// 反例把函数直接交给 map，数组下标会填进可选的 decimals 参数，格式化结果因此被截断。
const strs = [1.23, 4.56, 7.89].map(googFormat.numericValueToString);
// 反例的实际输出是截断后的字符串，小数位被 map 传入的下标改变，不再是原来的小数。

```

应优先传递一个显式把参数转发给具名回调的箭头函数。

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

#### 作为属性的箭头函数

类通常不应包含初始化为箭头函数的属性。箭头函数属性要求调用函数理解被调用者的 `this` 已经绑定，这增加了 `this` 是什么的困惑，而且使用这类处理函数的调用点和引用看起来是坏的（也就是需要非局部知识才能判断它们是对的）。代码应始终用箭头函数调用实例方法（`const handler = (x) => { this.listener(x); };`），不应取得或传递实例方法的引用（

`const handler = this.listener; handler(x);`

）。

> 注意：在某些特定情况，例如在模板里绑定函数时，作为属性的箭头函数很有用，也能写出可读得多的代码。对本规则运用判断。另见下面的 `Event Handlers` 一节。

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

#### 事件处理函数

不需要卸载处理函数时（例如事件由类自己发出），事件处理函数可以使用箭头函数。如果处理函数需要卸载，属性箭头函数是正确做法，因为它们自动捕获 `this`，并提供用于卸载的稳定引用。

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

不要在安装事件处理函数的表达式里使用 `bind`，因为它会创建一个无法卸载的临时引用。

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

#### 参数初始化器

可选函数参数可以给出默认初始化器，在省略参数时使用。初始化器不得有任何可观察的副作用。初始化器应尽量保持简单。

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

少用默认参数。当有不止一小撮没有自然顺序的可选参数时，优先用解构来创建可读的 API。

#### 适当时优先使用剩余参数和展开

使用剩余参数，不要访问 `arguments`。绝不要把局部变量或参数命名为 `arguments`，那会令人困惑地遮蔽内置名字。

```
function variadic(array: string[], ...numbers: number[]) {}

```

使用函数展开语法，不要使用 `Function.prototype.apply`。

#### 函数的格式

不允许在函数体的开头或结尾留空行。

函数体内可以少量使用一个空行，来形成语句的逻辑分组。

生成器应把 `*` 贴在 `function` 和 `yield` 关键字上，如 `function* foo()` 和 `yield* iter`，而不是

`function *foo()`

或

`yield *iter`

。

单参数箭头函数左侧的圆括号是推荐的，但不是必须的。

剩余参数或展开语法中的 `...` 后面不要加空格。

```
function myFunction(...elements: number[]) {}
myFunction(...array, ...iterable, ...generator());

```

#### 函数长度

编写小而专注的函数和类方法。

虽然不对函数和方法长度设置硬性限制，如果超过大约 40 行，想一想能否在不损害程序结构的情况下把它拆开。

这不是精确科学，但下面是方法可能过于复杂的一些迹象：

- 它有好几层嵌套。
- 它由几块各自需要注释来说明做什么的代码组成。
- 它必须在不同地方处理不同类型的异常。
- 它不能一次全部放进屏幕。

如果使用这样的函数证明很困难，你发现错误难以调试，或者想在几个不同上下文中使用其中一段，考虑把函数拆成更小、更好管理的片段。注意，只使用一次的私有辅助方法或类并没有什么不对；它们可以是让代码更可读的有用工具。

### this

只在类构造函数和方法、声明了显式 `this` 类型的函数（例如 `function func(this: ThisType, ...)`），或定义在可以使用 `this` 的作用域中的箭头函数里使用 `this`。

绝不要用 `this` 指代全局对象、`eval` 的上下文、事件的目标，或不必要地被 `call()` 或 `apply()` 的函数。

```
this.alert("Hello");

```

### 原始字面量

#### 字符串字面量

##### 使用双引号

普通字符串字面量用双引号（`"`）界定，与 Prettier 的 `singleQuote` 设为 false、`printWidth` 设为 120 一致。

例外：如果字符串包含双引号字符，可以用单引号界定，以避免转义该引号。

##### 不要续行

不要在普通字符串字面量或模板字符串字面量中使用续行（也就是在字符串字面量内部用反斜杠结束一行）。虽然 ES5 允许这样做，如果斜杠后面有任何尾随空白，就会导致棘手的错误，对读者也不那么明显。

不允许：

```
const LONG_STRING = "This is a very very very very very very very long string. \
        It inadvertently contains long stretches of spaces due to how the \
        continued lines are indented.";

```

应写成

```
const LONG_STRING = "This is a very very very very very very long string. " +
        "It does not contain long stretches of spaces because it uses " +
        "concatenated strings.";
const SINGLE_STRING =
        "http://it.is.also/acceptable_to_use_a_single_long_string_when_breaking_would_hinder_search_discoverability";

```

##### 模板字面量

当涉及多个字符串字面量时，优先使用模板字面量（用反引号界定），而不是复杂的字符串拼接。模板字面量可以跨越多行。

如果模板字面量跨越多行，它不必遵循外围块的缩进，不过如果多出来的空白无关紧要，也可以遵循。

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

数字可以用十进制、十六进制、八进制或二进制指定。十六进制、八进制和二进制分别精确使用 `0x`、`0o` 和 `0b` 前缀，字母小写。除非紧跟着 `x`、`o` 或 `b`，否则绝不包含前导零。

#### 类型强制转换

TypeScript 代码可以使用 `String()` 和 `Boolean()`（注意：不要 `new`！）函数、字符串模板字面量或 `!!` 来强制转换类型。

```
const bool = Boolean(0);
const str = String(aNumber);
const bool2 = !!str;
const str2 = `result: ${bool2}`;

```

枚举类型的值（包括枚举类型与其他类型的联合）不得用 `Boolean()` 或 `!!` 转换成布尔值，必须改用比较运算符显式比较。

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

对大多数目的而言，枚举名在运行时映射到什么数字或字符串值并不重要，因为源代码中通过名字引用枚举类型的值。因此工程师习惯于不去想这件事，于是它确实重要的情况是不受欢迎的，因为会令人意外。把枚举转换成布尔值就是这种情况；特别是，默认情况下第一个声明的枚举值为假（因为它是 0），其余为真，这很可能出人意料。使用枚举值的代码的读者甚至可能不知道它是不是第一个声明的值。

不鼓励用字符串拼接转换成字符串，因为我们检查加号运算符的操作数类型是否匹配。

##### 强制转换成数字

数字解析可能以多种多样的方式失败，有许多令人意外的边角情况，而不同的数字解析方法各自有不同、有时还不一致的行为（例如空白、空字符串、科学计数法、溢出到无穷、进制前缀等）。此外，在错误的层次解析常常是代码异味。代码必须检查任何数值强制转换的输出，并显式处理任何可能的、不抛异常的失败情况（例如处理任何 `NaN` 结果）。

代码不得使用一元加号（例如 `+str`）或 `parseFloat` 把字符串强制转换成数字。前者在代码评审中太容易漏掉，后者会静默忽略输入字符串末尾的垃圾。两种情况下都优先使用 `Number`。

除非需要非十进制基数，否则代码不得使用 `parseInt`。此时必须在解析前检查输入字符串是否有效（也就是所有字符都是有效数字），以确保末尾垃圾不会被静默忽略。输出也必须对照 `NaN` 检查。

```
const x = +y;
const x1 = parseFloat(y1);

```

```
const x = Number(y);
if (!isFinite(x)) throw new Error(...);

```

##### 隐式强制转换

不要在已有隐式布尔强制转换的条件子句中使用显式布尔强制转换（具体是 `if`、`for` 和 `while` 语句中的条件）。

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

与显式转换一样，枚举类型的值（包括枚举类型与其他类型的联合）不得被隐式强制转换成布尔值，必须改用比较运算符显式比较。

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

其他类型的值既可以隐式强制转换成布尔值，也可以用比较运算符显式比较：

```
// 长度需要和零比较时可以写成大于零，读者不用记住空数组在布尔上下文里算真还是算假。
if (arr.length > 0) {...}
// 数组长度也可以直接放进条件里，零是假值，非零是真值，和显式大于零的写法都允许，本例就是这样。
if (arr.length) {...}

```

### 控制结构

#### 控制流语句与块

控制流语句（`if`、`else`、`for`、`do`、`while` 等）始终为所含代码使用花括号块，即使主体只有一条语句。非空块的第一条语句必须从自己的一行开始。

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

例外：能放在一行的 `if` 语句可以省略块。

```
if (x) x.doFoo();

```

##### 控制语句中的赋值

优先避免在控制语句内部给变量赋值。控制语句里的赋值很容易被看成相等比较。

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

在确实优先在控制语句内部赋值的情况下，把赋值放进额外的圆括号，以表明这是有意的。

```
while ((x = someFunction())) {
    // 必须在循环条件里赋值时，用双层括号标明这是有意的赋值，而不是把等于号写成了赋值。
}

```

##### 迭代容器

优先用 `for (... of someArr)` 迭代数组。也允许 `Array.prototype.forEach` 和普通 `for` 循环：

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

`for`-`in` 循环只可用于字典式对象（更多信息见下文）。不要用 `for (... in ...)` 迭代数组，因为它会反直觉地给出数组的下标（而且是字符串！），不是值：

```
for (const x in someArray) {
    // 对数组使用 for-in 时，x 是下标字符串，不是元素，这个循环几乎总是写错了。
}

```

`for`-`in` 循环中应使用 `Object.prototype.hasOwnProperty` 来排除不想要的原型属性。尽可能优先使用带 `Object.keys`、`Object.values` 或 `Object.entries` 的 `for`-`of`，而不是 `for`-`in`。

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

只有当作者和评审者都认为，不加这些括号代码也不会被误读，而且加上括号也不会让代码更好读时，才省略可选的分组括号。不能合理地假定每个读者都背得出整张运算符优先级表。

不要在 `delete`、`typeof`、`void`、`return`、`throw`、`case`、`in`、`of` 或 `yield` 后面的整个表达式外再加不必要的括号。

#### 异常处理

异常是语言的重要部分，出现异常情况时就应该使用。

自定义异常是从函数传出额外错误信息的好办法。在原生 `Error` 类型不够用的地方，就应该定义并使用它们。

优先抛出异常，而不是临时的错误处理办法（例如传入一个错误容器引用类型，或返回一个带 error 属性的对象）。

##### 用 `new` 实例化错误

实例化异常时始终使用 `new Error()`，而不是直接调用 `Error()`。两种形式都会创建新的 `Error` 实例，但使用 `new` 与实例化其他对象的方式更一致。

```
throw new Error("Foo is not a valid bar.");

```

```
throw Error("Foo is not a valid bar.");

```

##### 只抛出错误

虽然 JavaScript 允许抛出任意值，但只有抛出的值是 `Error` 时才会填充栈追踪。不要抛出原始值（包括字符串、数字、null 或 undefined），也不要抛出不是 `Error` 或其子类实例的对象。这条限制也适用于所有可能抛出其参数的 API，包括 `Promise.reject`，以及 `AbortSignal` 的各种 `abort` 方法。

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

应当只抛出 `Error`（或其子类）：

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

注意：不带参数调用 `AbortController#abort` 或 `AbortSignal.abort` 是合法的，因为默认会创建一个新的 “AbortError” `DOMException`，并赋给 `AbortSignal#reason`（见 MDN）。

##### 捕获并重新抛出

捕获错误时，代码应假定所有抛出的错误都是 `Error` 的实例。

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

除非能够确凿地知道被调用的 API 违反上面的规则、会抛出非 `Error`，否则异常处理程序不得防御性地处理非 `Error` 类型。在那种情况下，应当加一条注释，具体指出这些非 `Error` 从哪里来。

```
try {
    badApiThrowingStrings();
} catch (e: unknown) {
    // 这个 API 明确会抛出字符串而不是 Error，只有在这种已经证实的情况下才按字符串处理。
    if (typeof e === "string") { ... }
}

```

避免过度防御性编程。对大多数代码里不会出现的问题反复做同样的防御，只会得到没有用处的样板代码。

##### 空的 catch 块

对捕获到的异常什么都不做，极少是正确的。当 catch 块里确实完全不采取任何行动是合适的时候，用注释说明为什么这样是合理的。

```
    try {
        return handleNumericResponse(response);
    } catch (e: unknown) {
        // 数值解析失败时落到文本处理。catch 里故意不改响应，只是换一条解析路径继续。
    }
    return handleTextResponse(response);

```

不允许：

```
    try {
        shouldFail();
        fail("expected an error");
    } catch (expected: unknown) {
    }

```

提示：与某些其他语言不同，上面这种模式根本不会奏效，因为它会捕获 `fail` 抛出的错误。改用 `assertThrows()`。

##### ErrorOptions 的 cause 必须是 Error 对象

为 ErrorOptions 参数传参时，`cause` 属性必须用 error 的子类型初始化。这实际上会建立一条带有有用栈追踪的错误对象链。

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

如果 `cause` 的初始化器引用的是类型为 unknown 的 catch 子句变量，可以省略类型检查，因为本代码库假定你不能抛出 `Error` 对象以外的东西。

```
try {
    ...
} catch (e: unknown) {
    // 新的 Error 把原来的值放进 cause，这里不必再判断 e 是不是 Error 的子类。
    throw new Error("Something went wrong", {cause: e});
}

```

在 TypeScript 里，类型 `Error` 恰好可以赋给 `ErrorOptions`。因此有可能不小心把一个错误对象当成 ErrorOptions 参数传进去，这很可能是代码里的缺陷。

```
try {
    ...
} catch (e: unknown) {
    if (e instanceof Error) {
        throw new Error("Something went wrong", e);
    }
}

```

#### switch 语句

所有 `switch` 语句都必须包含一个 `default` 语句组，即使它里面没有代码。`default` 语句组必须放在最后。

```
switch (x) {
    case Y:
        doSomethingElse();
        break;
    default:
        // 这个分支没有业务动作。空的 default 或空的 catch 必须说明为什么可以什么都不做。
}

```

在 switch 块内，每个语句组要么用 `break`、`return` 语句突然终止，要么抛出异常。非空语句组（`case ...`）不得贯穿（由编译器强制）：

```
switch (x) {
    case X:
        doSomething();
        // 反例从一个 case 掉进下一个 case，这种贯穿是禁止的，每个分支都要 break 或 return。
    case Y:
        // 这里省掉了和本条规则无关的语句，读者只需要看留下的那几行就能判断写法是否符合要求。
}

```

空语句组允许贯穿：

```
switch (x) {
    case X:
    case Y:
        doSomething();
        break;
    default:  // 这个分支没有业务动作。空的 default 或空的 catch 必须说明为什么可以什么都不做。
}

```

#### 相等检查

始终使用三等号（`===`）和不等号（`!==`）。双等号运算符会做容易出错的类型强制转换，既难理解，对 JavaScript 虚拟机来说实现起来也更慢。另见 JavaScript 相等表。

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

例外：与字面量 `null` 比较时，可以使用 `==` 和 `!=` 运算符，以便同时覆盖 `null` 和 `undefined`。

```
if (foo == null) {
    // foo == null 同时覆盖 null 和 undefined，这是严格相等之外少数允许的宽松比较。
}

```

#### 类型断言与不可空性断言

类型断言（`x as SomeType`）和不可空性断言（`y!`）是不安全的。二者都只是让 TypeScript 编译器安静下来，并不会插入与这些断言相符的运行时检查，因此可能让程序在运行时崩溃。

因此，如果没有明显或明确的理由，就不要使用类型断言和不可空性断言。

不要写成下面这样：

```
(x as Foo).foo();

y!.bar();

```

当你想断言类型或不可空性时，最好的办法是显式写一段执行该检查的运行时检查。

```
// 下面的示例假定 Foo 是一个类，instanceof 才能用来收窄 x 的类型。
if (x instanceof Foo) {
    x.foo();
}

if (y) {
    y.bar();
}

```

有时由于代码的某个局部性质，你可以确定断言形式是安全的。在这些情况下，你应当加上说明，解释为什么你可以接受这种不安全的行为：

```
// 这里把 x 断言成 Foo。断言会绕过检查，所以前面的理由必须写清楚，不能只留下省略号。
(x as Foo).foo();

// 非空断言表示 y 在这里不可能是 null 或 undefined，注释要写出这个前提从哪来。
y!.bar();

```

如果类型断言或不可空性断言背后的理由很明显，注释可能就不必要。例如，生成的 proto 代码总是可空的，但在这段代码的上下文里，某些字段总是由后端提供，这也许是众所周知的。请自行判断。

##### 类型断言语法

类型断言必须使用 `as` 语法（而不是尖括号语法）。这样在访问成员时会强制给断言加上括号。

```
const x = (<Foo>z).length;
const y = <Foo>z.length;

```

```
// 把 z 断言成 Foo 后再读 length。注释要说明为什么 z 在这里一定是 Foo。
const x = (z as Foo).length;

```

##### 双重断言

根据 TypeScript 手册，TypeScript 只允许转换成某个类型更具体或更不具体版本的类型断言。加上一条不符合该标准的类型断言（`x as Foo`）会得到错误：“Conversion of type ‘X’ to type ‘Y’ may be a mistake because neither type sufficiently overlaps with the other.”

如果你确定断言是安全的，可以做双重断言。这需要经由 `unknown` 做转换，因为它比所有类型都更不具体。

```
// 双重断言会绕过中间类型的检查，更要写明 x 为什么在这里可以当成 Foo，而不是别的类型。
(x as unknown as Foo).fooMethod();

```

用 `unknown`（而不是 `any` 或 `{}`）作为中间类型。

##### 类型断言与对象字面量

用类型注解（`: Foo`）而不是类型断言（`as Foo`）来指定对象字面量的类型。这样当接口的字段随时间变化时，可以查出重构缺陷。

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

#### 让 try 块保持聚焦

在不损害可读性的前提下，限制 try 块里的代码量。

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

把不会抛出的行移出 try/catch 块，有助于读者弄清哪个方法会抛异常。一些不会抛异常的内联调用可以留在里面，因为为它们再引入临时变量也许不值得增加那点复杂度。

例外：如果 try 块在循环内部，可能有性能问题。把 try 块加宽到覆盖整个循环是可以的。

### 装饰器

装饰器是带 `@` 前缀的语法，例如 `@MyDecorator`。

不要定义新的装饰器。只使用框架定义的装饰器：

- Angular（例如 `@Component`、`@NgModule` 等）
- Polymer（例如 `@property`）

为什么？

我们通常希望避免装饰器，因为它们曾经是实验性特性，此后已经与 TC39 提案分叉，并且有已知的、不会被修复的缺陷。

使用装饰器时，装饰器必须紧挨在它所装饰的符号前面，中间不能有空行：

```
/** 文档注释要写在装饰器前面，这样编辑器在装饰器元数据旁边也能显示这段说明，本例就是这样。 */
@Component({...})  // 装饰器和类声明之间不要插空行，空行会让文档注释和类看起来不再相连，本例就是这样。
class MyComp {
    @Input() myField: string;  // 字段的装饰器可以和字段写在同一行，字段名仍然紧跟在装饰器后面，不必为了短装饰器换行。

    @Input()
    myOtherField: string;  // 装饰器参数变长时可以单独占一行，字段声明再换到下一行，两种写法不要在无故时混用。
}

```

### 不允许的特性

#### 原始类型的包装对象

TypeScript 代码不得实例化原始类型 `String`、`Boolean` 和 `Number` 的包装类。包装类有令人意外的行为，例如 `new Boolean(false)` 的求值结果为 `true`。

```
const s = new String("hello");
const b = new Boolean(false);
const n = new Number(5);

```

可以把包装类当作函数调用来做强制转换（这比使用 `+` 或拼接空字符串更好），或用来创建符号。更多信息见类型强制转换。

#### 自动分号插入

不要依赖自动分号插入（ASI）。用分号显式结束所有语句。这可以防止因错误插入分号而产生的缺陷。

#### const 枚举

代码不得使用 `const enum`；改用普通的 `enum`。

TypeScript 的枚举本来就不能被修改；`const enum` 是与优化有关的另一项语言特性，它会让该枚举对模块的 JavaScript 使用者不可见。

#### debugger 语句

生产代码中不得包含 debugger 语句。

```
function debugMe() {
    debugger;
}

```

#### `with`

不要使用 `with` 关键字。它让代码更难理解，并且自 ES5 起已在严格模式中被禁止。

#### 动态代码求值

不要使用 `eval` 或 `Function(...string)` 构造函数（代码加载器除外）。这些特性有潜在危险，而且在使用严格内容安全策略的环境里根本不能工作。

#### 非标准特性

不要使用非标准的 ECMAScript 或 Web 平台特性。

这包括：

- 已被标记为弃用或已从 ECMAScript / Web 平台完全移除的旧特性（见 MDN）
- 尚未标准化的新 ECMAScript 特性

- 避免使用当前 TC39 工作草案中的特性，或目前仍在提案过程中的特性
- 只使用当前 ECMA-262 规范中定义的 ECMAScript 特性
- 已提案但尚未完成的 Web 标准：

- 尚未完成提案过程的 WHATWG 提案。
- 非标准的语言“扩展”（例如某些外部转译器提供的扩展）

针对特定 JavaScript 运行时的项目，例如仅最新 Chrome、Chrome 扩展、Node.JS、Electron，显然可以使用那些 API。在考虑专有且只在部分浏览器中实现的 API 表面时要谨慎；考虑是否有一个公共库能为你把这个 API 表面抽象掉。

#### 修改内置对象

绝不要修改内置类型，无论是往它们的构造函数上添加方法，还是往它们的原型上添加方法。避免依赖会这样做的库。

除非绝对必要（例如第三方 API 要求），不要往全局对象上添加符号。

## 命名

### 标识符

标识符只能使用 ASCII 字母、数字、下划线（用于常量和结构化的测试方法名），以及（很少）‘$’ 符号。

#### 命名风格

TypeScript 用类型表达信息，因此名字不应再装饰上类型里已经包含的信息。（关于不该包含什么，另见 Testing Blog。）

这条规则的一些具体例子：

- 不要为私有属性或方法使用前导或尾随下划线。
- 不要为可选参数使用 `opt_` 前缀。

- 关于访问器，见下面的访问器规则。
- 不要给接口做特殊标记（

`IMyInterface`

或

`MyFooInterface`

），除非这在它所处的环境里是惯用做法。为类引入接口时，给它一个能表达该接口当初为何存在的名字（例如，如果接口表达的是 JSON 存储/序列化所用的格式，就用 `class TodoItem` 和 `interface TodoItemStorage`）。
- 给 `Observable` 加上 `$` 后缀是一种常见的外部约定，有助于消除可观察值与具体值之间的混淆。这种约定是否有用，留给各个团队判断，但在项目内部应当一致。

#### 描述性名字

名字必须对新读者具有描述性并且清楚。不要使用对项目外读者含糊或陌生的缩写，也不要通过删掉单词内部的字母来缩写。

- 例外：作用域不超过 10 行的变量，包括不属于导出 API 的参数，可以使用短名字（例如单个字母）。

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

#### 驼峰命名

把名字里的缩写当作完整单词来处理，也就是使用 `loadHttpUrl`，而不是

`loadHTTPURL`

，除非平台名要求这样做（例如 `XMLHttpRequest`）。

#### 美元符号

标识符一般不应使用 `$`，除非第三方框架的命名约定要求这样做。关于对 `Observable` 值使用 `$`，见上文。

### 按标识符类型划分的规则

大多数标识符名字应按下表中的大小写，依据标识符的类型来命名。

| 风格 | 类别 |
| --- | --- |
| `UpperCamelCase` | 类 / 接口 / 类型 / 枚举 / 装饰器 / 类型参数 / TSX 中的组件函数 / JSXElement 类型参数 |
| `lowerCamelCase` | 变量 / 参数 / 函数 / 方法 / 属性 / 模块别名 |
| `CONSTANT_CASE` | 全局常量值，包括枚举值。见下面的常量。 |
| `#ident` | 私有标识符从不使用。 |

#### 类型参数

类型参数，例如 `Array<T>` 中的类型参数，可以使用单个大写字符（`T`），也可以使用 `UpperCamelCase`。

#### 测试名

xUnit 风格测试框架中的测试方法名可以用 `_` 分隔来组织，例如 `testX_whenY_doesZ()`。

#### 下划线（`_`）前缀/后缀

下划线前缀表示一个语法上必需的标识符不会被使用。鼓励在下划线后面提供一个有意义的名字，但单独一个 `_` 也是允许的。

```
(_projectId, api) => of(!params.disabledApis.includes(api));

[].filter((_, i) => i % 2 === 0);

for await (const _item of getAllTheThings()) {
    count++;
}

using _cleanupFoo = foo();

```

不要对尾部未使用的参数使用这种风格，那些参数应当省略。

专门打算被覆盖的方法上，允许保留尾部未使用的参数。

```
[].filter((element, _index) => !element.hasSomeProperty());

```

```
[].filter(element => !element.hasSomeProperty());

```

标识符不得使用 `_` 作为后缀。

> 提示：如果只需要数组（或 TypeScript 元组）中的部分元素，可以在解构语句里插入额外的逗号，以忽略中间的元素：
>
> ```
> // 解构时用空位跳过中间元素，a 得到 1，b 得到 10，被跳过的值不要再命名了。
> const [a, , b] = [1, 5, 10];
>
> ```

#### 导入

模块命名空间导入使用 `lowerCamelCase`，而文件使用 `snake_case`，这意味着正确的导入在大小写风格上不会匹配，例如

```
import * as fooBar from "./foo_bar";

```

有些库常用的命名空间导入前缀会违反这套命名方案，但过于普遍的开源用法使这种违规风格更好读。目前属于这一例外的库只有：

- jquery，使用 `$` 前缀
- threejs，使用 `THREE` 前缀

#### 常量

不可变：`CONSTANT_CASE` 表示一个值意图不被更改，也可以用于技术上仍能被修改的值（也就是没有被深度冻结的值），以告诉使用者不得修改它们。

```
const UNIT_SUFFIXES = {
    "milliseconds": "ms",
    "seconds": "s",
};
// JavaScript 里这个对象仍然可以改，全大写是在告诉调用方不要修改单位后缀表。

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

全局：只有在模块级声明的符号、模块级类的静态字段，以及模块级枚举的值，才可以使用 `CONST_CASE`。如果一个值在程序生命周期内可以被实例化不止一次（例如函数内声明的局部变量，或嵌套在函数里的类上的静态字段），它就必须使用 `lowerCamelCase`。局部作用域别名是例外，应当使用现有标识符的格式。

如果一个值是实现某个接口的箭头函数，则可以声明为 `lowerCamelCase`。

#### 别名

为现有符号创建局部作用域别名时，使用现有标识符的格式。局部别名必须与来源的现有命名和格式一致。变量的局部别名使用 `const`，类字段使用 `readonly` 属性。

> 注意：如果你创建别名只是为了把它暴露给你所选用框架的模板，记得同时加上合适的访问修饰符。

```
const {BrewStateEnum} = SomeType;
const CAPACITY = 5;

class Teapot {
    readonly BrewStateEnum = BrewStateEnum;
    readonly CAPACITY = CAPACITY;
}

```

#### 被覆盖和被实现的成员

覆盖、实现或收窄基类或接口成员的属性和方法，或出现在按上下文确定类型的对象字面量中的属性和方法，必须与现有声明的名字和大小写一致才能编译。因此大小写规则只适用于成员的原始声明，原始声明必须遵守这些规则，除非外部契约另有要求。如果可能，考虑修正原始声明的名字。

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

## 类型系统

### 类型推断

对所有类型表达式（变量、字段、返回类型等），代码可以依赖 TypeScript 编译器所实现的类型推断。

```
const x = 15;  // 局部变量的类型可以从 15 推断出来，不必在左侧再写一遍 number，注解在这里是重复的。

```

当类型可以平凡地推断出来时，省去类型注解：未导出的变量或参数，如果初始化为 `string`、`number` 或 `boolean` 字面量。对导出的符号，为了与 `isolatedDeclarations` 兼容而必须写出的类型注解，不视为平凡。

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

当显式泛型类型与类型注解重复时，也省去它们。

```
// 反例在变量和构造函数上各写了一次 string，构造函数的类型参数已经够用，左侧不必再写。
const x: Set<string> = new Set<string>();

```

```
const x = new Set<string>();  // 局部变量优先让构造函数的类型参数推断元素类型，不必在左侧再写 Set<string>。
// 导出的绑定需要显式类型，右侧可以省略类型参数，由左侧的 Set<string> 约束。
export const y: Set<string> = new Set();

```

对更复杂的表达式，类型注解有助于程序的可读性：

```
// 这条远程调用经过 transform 之后，不看实现就说不出 value 的类型，应在左侧写上类型。
const value = await rpc.getSomeValue().transform();

```

```
// 左侧写成 string 数组之后，读者不用打开 transform 的实现也知道 value 里是什么。
const value: string[] = await rpc.getSomeValue().transform();

```

是否需要注解，由代码评审者决定。

#### 返回类型

函数和方法是否包含返回类型注解，由代码作者决定。评审者可以要求加上注解，以说清难以理解的复杂返回类型。项目可以有本地策略，始终要求返回类型，但这不是一般的 TypeScript 风格要求。

显式写出函数和方法的隐式返回值有两个好处：

- 为代码读者提供更精确的文档。
- 如果以后的代码改动改变了函数的返回类型，可以更快暴露潜在的类型错误。

### undefined 与 null

TypeScript 支持 `undefined` 和 `null` 类型。可空类型可以构造成联合类型（`string|null`）；`undefined` 也类似。`undefined` 与 `null` 的联合没有特殊语法。

TypeScript 代码可以用 `undefined` 或 `null` 表示值的缺失，没有一般性指导说要优先哪一个。许多 JavaScript API 使用 `undefined`（例如 `Map.get`），而许多 DOM 和 Google API 使用 `null`（例如 `Element.getAttribute`），因此合适的缺失值取决于上下文。

#### 可空/undefined 类型别名

类型别名不得在联合类型中包含 `|null` 或 `|undefined`。可空别名通常表明 null 值正在穿过应用的太多层，这会模糊导致 `null` 的原始问题的来源。它们也会让人不清楚类或接口上的特定值何时可能缺失。

代码只应在别名真正被使用时才加上 `|null` 或 `|undefined`。代码应当在 null 值产生的附近处理它们，使用下面的技术。

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

### 使用结构类型

TypeScript 的类型系统是结构化的，不是名义化的。也就是说，如果一个值至少拥有类型所要求的全部属性，并且这些属性的类型递归地匹配，该值就匹配该类型。

在提供基于结构的实现时，在符号的声明处显式写上类型（这样可以做更精确的类型检查和错误报告）。

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

用接口而不是类来定义结构类型

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

上面的 “badFoo” 对象依赖类型推断。可以给 “badFoo” 增加额外字段，类型会根据对象本身来推断。

把 “badFoo” 传给接受 “Foo” 的函数时，错误会出现在函数调用点，而不是对象声明点。在大范围代码库中改变接口表面时，这一点也有用。

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

### 对象类型优先使用接口，而不是类型字面量别名

TypeScript 支持用类型别名给类型表达式命名。这可以用来给原始类型、联合、元组和任何其他类型命名。

但是，在为对象声明类型时，使用接口，而不是对象字面量表达式的类型别名。

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

这两种形式几乎等价，因此按照从两种形式里只选一种以避免差异的原则，我们应当选一种。此外，还有技术上的理由让人优先使用接口。那一页引用了 TypeScript 团队负责人的话：“老实说，凡是接口能够建模的东西，真的就应该只用接口。当显示和性能方面有这么多问题时，类型别名并没有好处。”

### `Array<T>` 类型

对简单类型（只包含字母数字字符和点），使用数组的语法糖 `T[]` 或 `readonly T[]`，而不是更长的形式 `Array<T>` 或 `ReadonlyArray<T>`。

对简单类型的多维非 `readonly` 数组，使用语法糖形式（`T[][]`、`T[][][]`，以此类推），而不是更长的形式。

对任何更复杂的类型，使用更长的形式 `Array<T>`。

这些规则适用于每一层嵌套，也就是说，嵌在更复杂类型里的简单 `T[]` 仍然写成 `T[]`，使用语法糖。

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

### 可索引类型 / 索引签名（`{[key: string]: T}`）

在 JavaScript 里，把对象当作关联数组（也就是 “map”、“hash” 或 “dict”）很常见。这类对象在 TypeScript 里可以用索引签名（`[k: string]: T`）来标注类型：

```
const fileSizes: {[fileName: string]: number} = {};
fileSizes["readme.txt"] = 541;

```

在 TypeScript 里，为键提供一个有意义的标签。（该标签只为文档而存在；除此之外不被使用。）

```
const users: {[key: string]: number} = ...;

```

```
const users: {[userName: string]: number} = ...;

```

> 与其使用其中某一种，不如考虑改用 ES6 的 `Map` 和 `Set` 类型。JavaScript 对象有令人意外的不良行为，而 ES6 类型更明确地传达你的意图。此外，`Map` 的键以及 `Set` 的元素可以是 `string` 以外的类型。

TypeScript 内置的 `Record<Keys, ValueType>` 类型允许构造具有一组已定义键的类型。这与关联数组不同，因为这些键是静态已知的。见下面关于这一点的建议。

### 映射类型与条件类型

TypeScript 的映射类型和条件类型允许基于其他类型指定新类型。TypeScript 标准库包含若干基于这些特性的类型操作符（`Record`、`Partial`、`Readonly` 等）。

这些类型系统特性允许简洁地指定类型，并构造强大且类型安全的抽象。不过它们也有若干缺点：

- 与显式指定属性和类型关系（例如使用接口和扩展，例子见下）相比，类型操作符要求读者在头脑中求值类型表达式。这会让程序明显更难读，尤其是再结合类型推断和跨文件边界的表达式时。
- 映射类型与条件类型的求值模型，尤其是与类型推断结合时，规范不足，并不总是被很好地理解，而且经常随 TypeScript 编译器版本变化。代码可能“偶然”编译通过，或看起来给出了正确结果。这增加了使用类型操作符的代码未来的维护成本。
- 映射类型与条件类型在从复杂类型和/或推断类型派生类型时最强大。反过来说，这也是它们最容易造出难以理解和维护的程序的时候。
- 有些语言工具不能很好地配合这些类型系统特性。例如，IDE 的查找引用（从而属性重命名重构）不会找到 `Pick<T, Keys>` 类型中的属性，Code Search 也不会给它们加超链接。 *

风格建议是：

- 始终使用能够表达你的代码的最简单类型构造。
- 一点点重复或冗长，往往比复杂类型表达式的长期成本便宜得多。
- 在考虑上述因素的前提下，可以使用映射类型与条件类型。

例如，TypeScript 内置的 `Pick<T, Keys>` 类型允许通过取另一个类型 `T` 的子集来创建新类型，但简单的接口扩展往往更容易理解。

```
interface User {
    shoeSize: number;
    favoriteIcecream: string;
    favoriteChocolate: string;
}

// FoodPreferences 只挑选两种食物字段，不包含 shoeSize，调用方不能从中读到鞋码。
type FoodPreferences = Pick<User, "favoriteIcecream"|"favoriteChocolate">;

```

这等价于把属性逐个写在 `FoodPreferences` 上：

```
interface FoodPreferences {
    favoriteIcecream: string;
    favoriteChocolate: string;
}

```

为了减少重复，可以让 `User` 扩展 `FoodPreferences`，或者（也许更好）嵌套一个表示食物偏好的字段：

```
// 这里的 FoodPreferences 与上面选出的两种食物字段相同，示例不再把字段重复写一遍。
interface FoodPreferences { }
interface User extends FoodPreferences {
    shoeSize: number;
    // User 扩展了食物偏好，因此除了鞋码还包含冰淇淋和巧克力这两个字段，调用方能直接读取。
}

```

这里使用接口让属性的分组变得明确，改善 IDE 支持，允许更好的优化，并且可以说让代码更容易理解。

### `any` 类型

TypeScript 的 `any` 类型是所有其他类型的超类型和子类型，并允许解引用所有属性。因此 `any` 是危险的：它可以掩盖严重的编程错误，而使用它会削弱当初拥有静态类型的价值。

考虑不要使用 `any`。在你想使用 `any` 的情况下，考虑下列之一：

- 提供一个更具体的类型
- 使用 `unknown`
- 抑制静态检查警告并记录原因

#### 提供更具体的类型

使用接口、内联对象类型或类型别名：

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

#### 用 `unknown` 代替 `any`

`any` 类型允许赋给任何其他类型，并允许从它解引用任何属性。这种行为常常并不必要或不可取，代码只需要表达某个类型是未知的。在这种情况下使用内置类型 `unknown`：它表达了这个概念，而且安全得多，因为它不允许解引用任意属性。

```
// unknown 可以接住任何值，包括 null 和 undefined，但在收窄或断言之前不能读取它的属性。
const val: unknown = value;

```

```
// 这个值来自任意表达式，示例用 any 接住它，用来对照后面那次未经检查的属性访问。
const danger: any = value;
danger.whoops();  // 通过 any 读取 whoops 不会做任何检查，拼写错误也会安静地变成运行时失败。

```

要安全地使用 `unknown` 值，用类型守卫收窄类型

#### 抑制 `any` 的静态检查警告

有时使用 `any` 是正当的，例如在测试里构造模拟对象。在这种情况下，加上一条抑制静态检查警告的注释，并记录为什么这是正当的。

```
// 这个测试只需要 BookService 的一部分。缺方法时测试会明显失败，所以这里有意做成不安全的部分替身。
// tslint:disable-next-line:no-any
const mockBookService = ({get() { return mockBook; }} as any) as BookService;
// 这个测试不会触碰购物车，用 any 占住构造参数只是为了满足签名，不代表购物车可以被随便替换。
// tslint:disable-next-line:no-any
// 购物车参数在这个测试里不会被读取，保留空值只是为了把构造函数的参数位置填上，本例就是这样。
const component = new MyComponent(mockBookService, null as any);

```

### `{}` 类型

`{}` 类型，也称为空接口类型，表示一个没有属性的接口。空接口类型没有指定的属性，因此任何非空值都可以赋给它。

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

Google3 代码在大多数用例中不应使用 `{}`。`{}` 表示任何非空的原始类型或对象类型，这很少是合适的。优先使用下列更有描述性的类型之一：

- `unknown` 可以容纳任何值，包括 `null` 或 `undefined`，对不透明值通常更合适。
- `Record<string, T>` 更适合类似字典的对象，并且通过显式写出所含值的类型 `T`（它本身可以是 `unknown`）提供更好的类型安全。
- `object` 还会排除原始类型，只留下非空的函数和对象，但不对可能有哪些属性做任何其他假设。

### 元组类型

如果你想创建一个 Pair 类型，改用元组类型：

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

不过，给属性提供有意义的名字往往更清楚。

如果声明一个 `interface` 太重，可以使用内联对象字面量类型：

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

### 包装类型

有几种与 JavaScript 原始类型相关的类型绝不应使用：

- `String`、`Boolean` 和 `Number` 与对应的原始类型 `string`、`boolean` 和 `number` 含义略有不同。始终使用小写版本。
- `Object` 与 `{}` 和 `object` 都有相似之处，但稍微更宽松。用 `{}` 表示除 `null` 和 `undefined` 以外的一切，或用小写 `object` 进一步排除其他原始类型（上面提到的三种，再加上 `symbol` 和 `bigint`）。

此外，绝不要把包装类型当作构造函数调用（使用 `new`）。

### 只有返回类型的泛型

避免创建只有返回类型泛型的 API。在使用已有的、只有返回类型泛型的 API 时，始终显式指定泛型。

## 工具链要求

Google 风格要求以特定方式使用若干工具，如下所述。

### TypeScript 编译器

所有 TypeScript 文件都必须使用标准工具链通过类型检查。

#### @ts-ignore

不要使用 `@ts-ignore`，也不要使用变体 `@ts-expect-error` 或 `@ts-nocheck`。

为什么？

它们表面上似乎是“修复”编译器错误的简单办法，但实际上，某个具体的编译器错误往往是由一个可以更直接修复的更大问题引起的。

例如，如果你用 `@ts-ignore` 抑制类型错误，就很难预测周围代码最终会看到什么类型。对许多类型错误，关于如何最好地使用 `any` 的建议是有用的。

你可以在单元测试中使用 `@ts-expect-error`，不过通常不应该。`@ts-expect-error` 会抑制所有错误。很容易意外匹配过多，从而抑制更严重的错误。考虑下列之一：

- 在测试那些需要在运行时处理未检查值的 API 时，转换成期望的类型或 `any`，并加上解释性注释。这把错误抑制限制在单个表达式上。
- 抑制静态检查警告并记录原因，类似于抑制 `any` 的静态检查警告。

### 一致性检查

Google TypeScript 包含若干一致性框架，tsetse 和 tsec。

这些规则通常用于强制关键限制（例如定义全局变量，那可能破坏代码库）和安全模式（例如使用 `eval` 或赋值给 `innerHTML`），或者更宽松地用于提高代码质量。

Google 风格的 TypeScript 必须遵守任何适用的全局或框架本地一致性规则。

## 注释与文档

#### JSDoc 与注释

有两类注释：JSDoc（`/** ... */`）和非 JSDoc 的普通注释（`// ...` 或 `/* ... */`）。

- 用 `/** JSDoc */` 注释做文档，也就是代码使用者应当阅读的注释。
- 用 `//` 行注释做实现注释，也就是只关心代码本身实现的注释。
- 每条注释都用中文书写。产品名 VeriQ 和技术标识可以保持原文。
- 注释块的第一行至少有 40 个字符的注释文字。每一行注释最多 80 个字符；超出部分换行。

JSDoc 注释可以被工具理解（例如编辑器和文档生成器），而普通注释只给其他人看。

#### 多行注释

多行注释与周围代码缩进在同一层级。它们必须使用多条单行注释（`//` 风格），而不是块注释风格（`/* */`）。

```
// 多行实现注释用连续的双斜线，每行单独成注释，不要改成会把说明包成一块的块注释，本例就是这样。

```

```
/** 反例用块注释包了多行实现说明，这种说明必须改成连续的双斜线，不能留在块注释里，本例就是这样。 */

/** 反例用单行块注释写实现说明。这种说明应使用双斜线，块注释不是实现注释的形式，本例就是这样。 */

```

注释不用星号或其他字符画成的方框围起来。

### JSDoc 的一般形式

JSDoc 注释的基本格式如本例所示：

```
/**
 * 多行文档按普通句子换行，参数标签各自独占一行，不要把说明和标签挤在同一行里，本例就是这样。
 * @param arg 交给函数处理的数字，调用方要保证它是有限数值。
 */
function doSomething(arg: number) { … }

```

或如这个单行例子：

```
/** 这个函数按参数完成一次转换，文档要说明转换结果交给谁，而不是只把函数名再说一遍。 */
function doSomething(arg: number) { … }

```

如果单行注释溢出到多行，它必须使用多行风格，把 `/**` 和 `*/` 各自放在单独的行上。

许多工具从 JSDoc 注释中提取元数据，以做代码验证和优化。因此这些注释必须格式正确。

### Markdown

JSDoc 用 Markdown 书写，必要时也可以包含 HTML。

这意味着解析 JSDoc 的工具会忽略纯文本格式，所以如果你这样写：

```
/**
 * 重量由三项因素一起决定。纯文本换行会被文档工具拼成一段，读者看不到原来的分行，本例就是这样。
 * 发出的件数
 * 收到的件数
 * 最后一次的时间戳
 */

```

它会被渲染成这样：

```
Computes weight based on three factors: items sent items received last timestamp

```

应当改写成 Markdown 列表：

```
/**
 * 重量由下面三项一起决定，列表必须写成 Markdown，文档工具才会保留项目符号。
 *
 * - 发出的件数
 * - 收到的件数
 * - 最后一次的时间戳
 */

```

### JSDoc 标签

Google 风格允许 JSDoc 标签的一个子集。大多数标签必须独占一行，标签位于行首。

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

### 换行

换行后的块标签缩进四个空格。换行后的描述文字可以与前面几行的描述对齐，但不鼓励这种水平对齐。

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

换行 `@desc` 或 `@fileoverview` 描述时不要缩进。

### 为模块的所有顶层导出写文档

用 `/** JSDoc */` 注释向代码使用者传达信息。避免仅仅复述属性或参数的名字。你还应当为所有目的不能从其名字立即看出来的属性和方法（无论是否导出/公开）写文档，是否立即明显由评审者判断。

例外：只为了被工具消费而导出的符号，例如 @NgModule 类，不需要注释。

### 类注释

类的 JSDoc 注释应当为读者提供足够的信息，让他们知道如何以及何时使用该类，以及正确使用该类所需的任何额外考虑。构造函数上可以省略文字描述。

### 方法和函数注释

如果方法描述、参数和返回值从该方法其余的 JSDoc，或从方法名和类型签名就能看出来，就可以省略。

方法描述使用中文。注释块的第一行至少 40 个字符，每一行注释最多 80 个字符。描述方法做什么；不要照抄英文的 “This method …” 前缀。

### 参数属性注释

参数属性是带有修饰符 `private`、`protected`、`public` 或 `readonly` 之一作为前缀的构造函数参数。参数属性同时声明一个参数和一个实例属性，并隐式地把参数赋给该属性。例如 `constructor(private readonly foo: Foo)` 声明构造函数接受参数 `foo`，同时也声明一个私有只读属性 `foo`，并在执行构造函数其余部分之前把该参数赋给该属性。

要为这些字段写文档，使用 JSDoc 的 `@param` 注解。编辑器会在构造函数调用和属性访问上显示这段描述。

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

### JSDoc 类型注解

JSDoc 类型注解在 TypeScript 源码中是多余的。不要在 `@param` 或 `@return` 块里声明类型，不要在已经使用 `implements`、`enum`、`private`、`override` 等关键字的代码上再写 `@implements`、`@enum`、`@private`、`@override` 等。

### 让注释真正增加信息

对未导出的符号，函数或参数的名字和类型有时就够了。不过代码通常会从比变量名更多的文档中受益！

- 避免只是复述参数名和类型的注释，例如

```
/** 反例只是把参数名 fooBarService 再说成 Foo 应用的 Bar 服务，没有增加调用方还不知道的信息。 */

```
- 由于这条规则，`@param` 和 `@return` 行只在它们增加信息时才需要，否则可以省略。

```
/**
 * 向冲煮服务发送启动请求，并按升数准备这一壶咖啡，调用方传入的升数不能超过壶的容量。
 * @param amountLitres 本次冲煮的升数，必须能装进当前壶的容量，超出时调用方要先减少用量。
 */
brew(amountLitres: number, logger: Logger) {
    // 这里省掉了和本条规则无关的语句，读者只需要看留下的那几行就能判断写法是否符合要求。
}

```

#### 调用函数时的注释

每当方法名和参数值不足以传达参数含义时，就应当使用“参数名”注释。

在添加这些注释之前，考虑把方法重构为改为接受一个接口并解构它，以大幅改善调用点的可读性。

“参数名”注释放在参数值之前，并包含参数名和 `=` 后缀：

```
// 调用点在值前面或值后面重复参数名，因为只看 true 和字符串看不出它们对应 shouldRender 还是 name。
someFunction(obviousParam, /* shouldRender= */ true, /* name= */ "hello");

```

现有代码可能使用一种遗留的参数名注释风格，把这些注释放在参数值之后，并省略 `=`。为了一致，在同一文件内继续使用这种风格是可以接受的。

```
// 调用点在值前面或值后面重复参数名，因为只看 true 和字符串看不出它们对应 shouldRender 还是 name。
someFunction(obviousParam, true /* shouldRender */, "hello" /* name */);

```

### 把文档放在装饰器之前

当类、方法或属性同时有 `@Component` 这样的装饰器和 JsDoc 时，请确保把 JsDoc 写在装饰器之前。

- 不要把 JsDoc 写在装饰器和被装饰语句之间。

```
@Component({
    selector: "foo",
    template: "bar",
})
/** 这个组件把模板里的 bar 渲染出来，文档要放在装饰器之前，编辑器才能在选择器旁显示说明。 */
export class FooComponent {}

```
- 把 JsDoc 块写在装饰器之前。

```
/** 这个组件把模板里的 bar 渲染出来，文档要放在装饰器之前，编辑器才能在选择器旁显示说明。 */
@Component({
    selector: "foo",
    template: "bar",
})
export class FooComponent {}

```

## 策略

### 一致性

对本规范没有明确解决的任何风格问题，按同一文件中其他代码已经在做的方式去做（“保持一致”）。如果这样仍不能解决问题，考虑仿照同一目录中的其他文件。

全新文件必须使用 Google 风格，无论同一包中其他文件做了什么风格选择。往一个不是 Google 风格的文件里添加新代码时，建议先按下面的建议重新格式化现有代码。如果不做这种重新格式化，新代码应尽可能与同一文件中的现有代码保持一致，但不得违反风格指南。

#### 重新格式化现有代码

你偶尔会在代码库中遇到不符合规范 Google 风格的文件。它们可能来自一次收购，可能写于 Google 风格对某个问题表态之前，也可能因为任何其他原因而不是 Google 风格。

更新现有代码的风格时，遵循这些指导。

1. 并不要求把所有现有代码都改成符合当前风格指南。重新格式化现有代码是代码扰动与一致性之间的权衡。风格规则会随时间演变，为了保持合规而做这类微调会造成不必要的扰动。不过，如果对一个文件做了重大修改，就期望该文件符合 Google 风格。
2. 小心不要让顺手的风格修复搅乱一次变更的焦点。如果你发现自己做了大量对变更的中心焦点并不关键的风格修改，把那些修改提升到单独的变更里。

### 弃用

用 `@deprecated` JSDoc 注解标记已弃用的方法、类或接口。弃用注释必须包含简单、清楚的说明，告诉人们如何修复他们的调用点。

### 生成的代码：大体豁免

构建过程生成的源代码不要求符合 Google 风格。不过，任何会从手写源代码引用的生成标识符都必须遵守命名要求。作为特殊例外，这类标识符允许包含下划线，这有助于避免与手写标识符冲突。

#### 风格指南的目标

一般而言，工程师通常最清楚自己的代码需要什么，因此如果有多个选项且选择取决于具体情况，我们就应当让决定在本地做出。所以默认答案应当是“把它省掉”。

下列几点是例外，也是我们制定一些全局规则的原因。用下面这些标准评估你的风格指南提案：

1. 代码应避免已知会导致问题的模式，尤其是对刚接触这门语言的用户。
2. 各项目的代码应当在无关紧要的差异上保持一致。

当有两个在表面上等价的选项时，我们应当考虑只选一个，这样我们就不会无缘无故地分叉演化，也能避免代码评审中毫无意义的争论。

例子：

- 名字的大小写风格。
- `x as T` 语法与等价的 ` x` 语法（不允许）。
- `Array<[number, number]>` 与 `[number, number][]`。
3. 代码应当能够长期维护。

代码的寿命通常比原作者在它上面工作的时间更长，而 TypeScript 团队必须让整个 Google 在未来继续工作。

例子：

- 我们用软件自动修改代码，因此代码是自动格式化的，以便软件容易满足空白规则。
- 我们要求一套统一的编译器标志，这样给定的 TS 库可以假定一组特定的标志来编写，使用者始终可以安全地使用共享库。
- 代码必须导入它使用的库（“严格依赖”），这样依赖项中的重构就不会改变其使用者的依赖。
- 我们要求使用者编写测试。没有测试，我们就无法确信我们对语言所做的修改不会破坏使用者。
4. 代码评审者应当专注于提高代码质量，而不是强制执行任意规则。

如果有可能把你的规则实现成自动检查，这通常是一个好迹象。这也支持第 3 条原则。

如果它其实没那么重要——如果它是语言的一个冷僻角落，或者它避免的是一个不太可能发生的缺陷——那大概值得省掉。

1. 命名空间导入常被称为“模块导入”。 ↩
2. 具名导入有时被称为“解构导入”，因为它们使用与解构赋值相似的语法。 ↩
