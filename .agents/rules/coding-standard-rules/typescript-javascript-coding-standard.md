# TypeScript and JavaScript coding standard

## 引言

### 术语说明

本风格指南在使用 must、must not、should、should not 和 may 时采用 RFC 2119 的术语。prefer 和 avoid 分别对应 should 和 should not。祈使句和陈述句是规定性的，对应 must。正文里的编码规则写成必须或禁止。

### 指南说明

所给示例都不是规范性的，只用来说明风格指南的规范性文字。示例中的可选格式选择不得被当作规则强制执行。

## VeriQ 格式规则

这些规则是规范性的，与 Google 原文不一致时以这里为准。

- 块使用 4 个空格缩进。禁止使用 Tab。嵌套块每层增加 4 个空格。续行必须与开分隔符对齐，或相对语句起点悬挂缩进 4 个空格。
- 代码和导入语句均须遵守[显示列宽硬上限](../coding-standard.md#11-显示列宽的统一计算)。Prettier 的 `printWidth` 按[编码规范总则](../coding-standard.md#1-格式与工具)设置排版目标。
- 普通字符串字面量使用双引号，与 Prettier 的 `singleQuote: false` 一致。见字符串字面量一节。
- 注释和 JSDoc 使用中文，均须遵守[正文长度](../coding-standard.md#12-注释正文长度)与[显示列宽](../coding-standard.md#11-显示列宽的统一计算)要求。
- 产品名 VeriQ 和技术标识允许在中文注释里保持原文。
- 固定工具词元须满足[工具语法计量规格](../../../docs/specs/tool-syntax-accounting.md)确认的拼法与 AST 位置。合格词元贡献 `C=0`，所在非空物理行保留在 `K`，继续检查显示列宽和同行普通说明。

## 源文件基础

### 文件编码：UTF-8

源文件必须使用 UTF-8 编码。

除行终止序列外，ASCII 水平空格字符（0x20）是源文件中唯一允许的空白字符。字符串字面量中的所有其他空白字符必须转义。

对任何有特殊转义序列的字符（`\'`、`\"`、`\\`、`\b`、`\f`、`\n`、`\r`、`\t`、`\v`），必须使用该序列，禁止对应的数字转义（例如 `\x0a`、`\u000a` 或 `\u{a}`）。禁止旧式八进制转义。

其余可打印的非 ASCII 字符必须使用实际的 Unicode 字符（例如 `∞`）。不可打印字符必须使用等价的十六进制或 Unicode 转义，并附上说明性注释。

```
// 直接写出微秒符号 μs，读者不用对照转义表，这种可打印字符不必再额外加注释，本例就是这样。
const units = "μs";

// 不可打印字符用转义写出来，并在旁边说明它是什么，避免文件里留下看不见的码位，本例就是这样。
const output = "\ufeff" + content;  // 这里的转义是字节顺序标记。不写明的话，读者只能看到一串十六进制，不知道该不该留。
```


## 源文件结构

文件必须按下列顺序组成：版权信息（如果有）、带 `@fileoverview` 或其他文件级 JSDoc 的 JSDoc（如果有）、导入（如果有）、文件的实现。每个存在的节之间恰好空一行。

许可证或版权信息必须放在文件顶部的 JSDoc 里。

文件允许有顶层 `@fileoverview` JSDoc。有的话，它必须描述文件内容、用途或依赖。换行后的行禁止缩进。

```
/**
 * 文件概览要写这个模块负责什么、谁会导入它，不要用占位的拉丁文把概览凑长，本例就是这样。
 *
 * 换行后的概览不要再缩进，保持和第一行说明同一列。
 */
```


### 导入

命名空间导入也称模块导入。具名导入也称解构导入。

| 导入类型 | 形式 | 用途 |
| --- | --- | --- |
| 模块 | `import * as foo from "...";` | TypeScript 导入 |
| 具名 | `import {SomeThing} from "...";` | TypeScript 导入 |
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


TypeScript 代码必须使用路径导入其他 TypeScript 代码。路径允许相对（以 `.` 或 `..` 开头），也允许根植于基目录（例如 `root/path/to/file`）。引用同一逻辑项目内的文件时，必须使用相对导入（`./foo`），禁止绝对导入 `path/to/foo`。必须限制父级步数（`../../../`）。

```
import {Symbol1} from "path/from/root";
import {Symbol2} from "../parent/file";
import {Symbol3} from "./sibling";
```


命名空间导入和具名导入都允许。文件中频繁使用的符号，或名字清楚的符号（例如 Jasmine 的 `describe` 和 `it`），必须使用具名导入。需要时必须用 `as` 改成更清楚的名字。从大型 API 使用许多不同符号时，必须使用命名空间导入。对 `Model` 或 `Controller` 这类常见名字，必须使用命名空间导入，禁止在导入行里排列一长串别名。

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


```
// 正例导入整个模块，再用模块名访问 Item，避免在导入行里排列一长串别名，本例就是这样。
import * as tableview from "./tableview";

let item: tableview.Item|undefined;
```


Apps JSPB proto 必须使用具名导入，即使导入行很长。

```
// 从 proto 文件只导入这次用到的消息，构建才能按消息裁剪，而不是把整份 proto 拉进来。
import {Foo, Bar} from "./foo.proto";

function copyFooBar(foo: Foo, bar: Bar) {...}
```


名字冲突必须通过命名空间导入或重命名导出本身解决。需要时允许 `import {SomeThing as SomeOtherThing}`。必须重命名的情况是：避免与其他导入符号冲突、导入的符号名是生成的、导入的符号本身名字不清楚（例如把 RxJS 的 `from` 重命名为 `observableFrom`）。

### 导出

所有代码必须使用具名导出。禁止默认导出。必须用文件作用域做命名空间，禁止把常量和辅助函数塞进类里以便一起导出。

```
export const SOME_CONSTANT = ...
export function someHelpfulFunction()
export class Foo {
    // 这个类体只放属于类的成员，文件里的其他函数不要塞进类里，免得实例上出现无用字段。
}
```


```
// 模块使用具名导出，导入方必须写出同一个名字，重命名不会悄悄指向另一份实现，本例就是这样。
export class Foo { ... }
```


只导出模块外部会使用的符号。必须尽量缩小模块导出的 API 表面。

禁止 `export let`。外部可访问且可变的绑定必须改用显式的读取函数。有条件地导出两个值之一时，必须先做条件判断，再 `export const`。模块主体执行完毕后，所有导出都必须是最终的。

```
function pickApi() {
    if (useOtherApi()) return OtherApi;
    return RegularApi;
}
export const SomeApi = pickApi();
```


```
let foo = 3;
window.setTimeout(() => {
    foo = 4;
// 延时的单位是毫秒。只写 1000 时，读者无法判断 setTimeout 的第二个参数是秒还是毫秒。
}, 1000);
// 可变状态留在模块内部，对外只提供读取函数，导入方就不会依赖一个随后会变的绑定，本例就是这样。
export function getFoo() { return foo; };
```


禁止为了做命名空间而创建带静态方法或静态属性的容器类。必须导出单独的常量和函数。

```
export const FOO = 1;
export function bar() { return 1; }
```


### 导入类型与导出类型

导入的符号只当作类型使用时，必须使用 `import type`。值必须使用普通导入。同一语句中允许 `import {type Foo, Bar}`。需要强制为副作用做运行时加载时，必须使用 `import "...";`。

```
import type {Foo} from "./foo";
import {Bar} from "./foo";

import {type Foo, Bar} from "./foo";
```


再导出类型时必须使用 `export type`。禁止用 `export type` 假装某个值符号没有被导出；必须把类型用法和值用法拆成不同符号。

```
export type {AnInterface} from "./foo";
```


禁止在类型注解里使用 `import()`。必须改用 `import type`。

```
import type {Foo} from "./foo";
```


禁止使用命名空间。代码必须用 `import {foo} from "bar";` 引用其他文件中的代码。禁止 `namespace Foo { ... }`，也禁止旧式 `module Foo { ... }`。只有必须与外部第三方代码对接时才允许 `namespace`。要用语义上的命名空间组织代码，必须使用单独的文件。禁止 `import x = require("...")`，也禁止三斜线 `reference`。必须使用 ES6 模块语法。

本风格指南没有讨论的语言特性允许使用，本指南不另加限制。

## 语言特性

### 局部变量声明

必须用 `const` 或 `let` 声明变量。默认必须使用 `const`，除非变量需要被重新赋值。禁止 `var`。变量禁止在声明之前使用。每条局部变量声明只允许声明一个变量。

```
const foo = otherValue;  // foo 在初始化之后不再赋值，所以用 const，读者可以把它当成这份模块里的稳定绑定。
let bar = someValue;  // bar 后面还会被重新赋值，必须用 let，不能为了省事写成初始化之后不能再改的 const。
```

### 数组字面量

禁止使用 `Array()` 构造函数，无论有没有 `new`。必须用方括号记法初始化数组，或用 `Array.from` 初始化特定大小的数组。禁止先建空数组再改 `length` 来制造空槽。需要固定长度的填充数组时必须使用 `Array.from` 再 `fill`。

```
const a = [2];
const b = [2, 3];

// 先建空数组再改 length，效果和只传长度的构造函数一样，数组里留下的仍是空槽。
const c = [];
c.length = 2;

// 需要固定长度的零填充数组时，用 Array.from 再 fill，不要依赖构造函数的长度参数。
Array.from<number>({length: 5}).fill(0);
```


禁止在数组上定义或使用非数字属性（`length` 除外）。必须改用 `Map` 或 `Object`。

赋值左侧允许数组解构。剩余元素的 `...` 与变量名之间禁止空格。未使用的元素必须省略。解构的数组参数如果可选，必须把 `[]` 指定为默认值，并在左侧提供默认值。禁止 `function badDestructuring([a, b] = [4, 2])`。

```
function destructured([a = 4, b = 2] = []) { … }
```


```
const [a, b, c, ...rest] = generateResults();
let [, b,, d] = someArray;
```


把多个值装进或拆出函数的参数或返回值时，必须使用对象解构，禁止使用数组解构，以便给各个元素命名并为每个元素指定不同的类型。

### 对象字面量

禁止使用 `Object` 构造函数。必须使用对象字面量（`{}` 或 `{a: 0, b: 1, c: 2}`）。

禁止未过滤的 `for (... in ...)`。必须用 `if` 显式过滤，或使用 `for (... of Object.keys(...))`、`Object.entries`。

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


对象初始化中的展开语法允许。同一键上后面的值替换前面的值。禁止展开原型不是 `Object` 原型的对象（类定义、类实例、函数、数组）。

```
const options = {foo: 1, bar: 2};
const extended = {...options, baz: 3};
```


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


计算属性名允许，并且必须视为字典式（加引号的）键，禁止与不加引号的键混用。例外：计算属性是符号（例如 `[Symbol.iterator]`）时允许。

对象解构允许。作为函数参数时必须只有一层不加引号的简写属性。禁止更深的嵌套和计算属性。默认值必须写在左侧（`{str = "some default"} = {}`）。解构的对象本身可选时，必须默认为 `{}`。

```
interface Options {
    /**
     * 这个可选数字表示同一操作要重复的次数，不传时由调用方的默认逻辑决定重复几次，本例就是这样。
     */
    num?: number;

    /**
     * 这个可选字符串是被处理的文本，缺省时使用参数初始化器里的默认文本，而不是空串，本例就是这样。
     */
    str?: string;
}

function destructured({num, str = "default"}: Options = {}) {}
```


### 类

类声明禁止以分号结尾。包含类表达式的语句必须以分号结尾。类体大括号内侧的空行没有统一要求，同一类内禁止混用有空行和没空行。

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


```
export const Baz = class extends Bar {
    method(): number {
        return this.x;
    }
};  // 把类表达式赋给常量属于语句，末尾的分号必须保留，单独写出的类声明才不需要分号，本例就是这样。
```


```
class Foo {
}
```


只在构造函数中使用的变量必须改成构造函数体里的局部变量。只在构造期间使用的状态同样必须改成构造函数的局部变量。

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


类方法声明之间禁止用分号分隔。方法声明必须与周围代码用一个空行隔开。

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
}
```


允许覆盖 `toString`，但它必须始终成功，并且禁止有可见的副作用。禁止从 `toString` 调用可能再次进入 `toString` 的方法。

不影响可读性时，必须使用模块局部函数，禁止私有静态方法。

禁止依赖静态方法的动态分派。静态方法只允许在定义它的基类本身上调用。禁止在可能是构造函数或子类构造函数的变量上调用静态方法，除非该方法用 `@nocollapse` 定义。禁止在自己没有定义该方法的子类上调用。静态上下文中禁止使用 `this`。

构造函数调用必须使用圆括号，即使不传递参数。禁止空构造函数，也禁止只委托给父类的构造函数。带参数属性、可见性修饰符或参数装饰器的构造函数即使函数体为空也必须保留。用于禁止实例化的私有构造函数必须保留。构造函数上下都必须与周围代码用一个空行隔开。

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


```
const x = new Foo();
```


禁止私有字段（`#ident`）。必须使用 TypeScript 的可见性注解（`private`）。

```
class Clazz {
    private ident = 1;
}
```


构造函数之外不再重新赋值的属性必须用 `readonly` 标记。它们不必是深度不可变的。

禁止把显而易见的初始化再赋给类成员。必须使用 TypeScript 参数属性。参数属性的文档必须使用 `@param`。

```
class Foo {
    constructor(private readonly barService: BarService) {}
}
```


初始化类成员不依赖构造函数参数或参数属性时，必须在声明处初始化。禁止从字段初始化器引用参数属性。构造函数结束后，禁止再向实例添加或移除属性。以后可能填上的可选字段必须显式初始化为 `undefined`。

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


```
class Foo {
    private readonly userList: string[] = [];
}
```


从其包含类的词法作用域之外使用的属性，禁止使用 `private`。例外：只从模板使用的 Angular 组件属性允许 `private`。其余必须使用合适的 `protected` 或 `public`。禁止用 `obj["foo"]` 绕过可见性。

允许读取器和设置器。读取器必须是纯函数：结果一致，禁止改变可观察状态。被隐藏的属性必须用完整单词作前缀或后缀，例如 `internal` 或 `wrapped`。使用这些私有属性时必须通过访问器取值。一个属性至少要有一个并非平凡的访问器。禁止只为了隐藏属性而定义直通访问器；必须把属性公开，或做成 `readonly`。禁止用 `Object.defineProperty` 定义读取器和设置器。

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


只有当属性是符号时，类中才允许计算属性。禁止字典式属性（加引号的或计算的非符号键）。逻辑上可迭代的类必须定义 `[Symbol.iterator]`。除此之外必须少用 `Symbol`，禁止把它当作普通字符串键的替代。禁止依赖编译器不会 polyfill 的其他内置符号（例如 `Symbol.isConcatSpreadable`）。

必须限制属性、方法和类型的可见性。私有方法必须转换成同一文件中、任何类之外的非导出函数；私有属性必须移到单独的、非导出的类里，除非这样做会损害可读性。除了声明非只读的公开参数属性之外，禁止使用 `public` 修饰符。

```
class Foo {
    bar = new Bar();  // 正例不写 public，字段保持默认的公开可见性，读者不会多看到一个无意义的修饰符。

    // 非只读的参数属性必须写出 public，否则它只是构造参数，不会变成实例上的字段。
    constructor(public baz: Baz) {}
}
```


禁止直接操作 `prototype`。禁止混入，以及修改内置对象的原型。例外：框架代码（例如 Polymer 或 Angular）需要使用 `prototype` 时允许，禁止为了避免这样做而采取更糟的变通办法。

### 函数

术语与 MDN 一致：函数声明是使用 `function` 关键字的声明；函数表达式是使用 `function` 关键字的表达式；箭头函数使用 `=>`；块体是带花括号的箭头函数右侧；简洁体是不带花括号的箭头函数右侧。本节不讨论方法和构造函数。

定义具名函数时必须使用函数声明，禁止箭头函数或函数表达式。需要显式类型注解时允许箭头函数。

```
function foo() {
    return 42;
}
```

```
interface SearchFunction {
    (source: string, subString: string): boolean;
}

const fooSearch: SearchFunction = (source, subString) => { ... };
```


嵌套在其他方法或函数中的函数允许使用函数声明或箭头函数。方法体里必须使用箭头函数，以便访问外层的 `this`。

禁止函数表达式，必须改用箭头函数。例外：必须动态重新绑定 `this` 时，或用于没有箭头语法的生成器函数时，允许函数表达式。新代码禁止动态重新绑定 `this`。

```
bar(() => { this.doSomething(); })
```


只有当返回值真的被使用时，才允许简洁体。返回值不被使用时必须使用块体。必须留在表达式体里时，必须用 `void` 运算符丢掉返回值。

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


函数表达式和函数声明禁止使用 `this`，除非它们专门用来重新绑定 `this`。必须使用箭头函数或显式参数。禁止 `f.bind(this)`、`goog.bind(f, this)` 和 `const self = this`。

```
// 正例用箭头函数直接写 document.body，不依赖调用时绑定的 this。
document.body.onclick = () => { document.body.textContent = "hello"; };
// 也可以把目标元素当成显式参数，再用 bind 传入 body，调用点能看见 this 被固定成谁。
const setTextFn = (e: HTMLElement) => { e.textContent = "hello"; };
document.body.onclick = setTextFn.bind(null, document.body);
```


除非两个函数的调用签名都稳定，禁止把具名回调直接传给高阶函数。必须传递显式转发参数的箭头函数。尤其必须挡住较少使用的可选参数。局部函数的参数就是回调会收到的元素时，允许直接传递该函数。

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


类禁止包含初始化为箭头函数的属性。必须在调用点用箭头函数调用实例方法。禁止取得或传递实例方法的引用。例外：模板里绑定函数，以及下面的事件处理函数。

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


不需要卸载处理函数时，事件处理函数必须使用箭头函数。需要卸载时，必须使用属性箭头函数，以捕获 `this` 并提供稳定引用。禁止在安装事件处理函数的表达式里使用 `bind`。

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


可选函数参数允许默认初始化器。初始化器禁止任何可观察的副作用，并且必须保持简单。禁止把可变对象或会改变外部状态的表达式当作默认值。必须少用默认参数。有不止一小撮没有自然顺序的可选参数时，必须用解构。

```
function process(name: string, extraContext: string[] = []) {}
function activate(index = 0) {}
```


必须使用剩余参数，禁止访问 `arguments`。禁止把局部变量或参数命名为 `arguments`。必须使用函数展开语法，禁止 `Function.prototype.apply`。

```
function variadic(array: string[], ...numbers: number[]) {}
```


函数体的开头和结尾禁止空行。函数体内允许少量使用一个空行来形成逻辑分组。生成器必须把 `*` 贴在 `function` 和 `yield` 上，即 `function* foo()` 和 `yield* iter`。单参数箭头函数左侧的圆括号不是强制格式。剩余参数或展开语法中的 `...` 后面禁止空格。

```
function myFunction(...elements: number[]) {}
myFunction(...array, ...iterable, ...generator());
```


必须编写小而专注的函数和类方法。函数和方法长度没有硬性上限。超过大约 40 行时必须拆开，除非拆开会损害程序结构。有好几层嵌套、由几块各自需要注释的代码组成、必须在不同地方处理不同类型的异常，或不能一次全部放进屏幕时，必须拆开。只使用一次的私有辅助方法或类允许存在。

### this

只允许在类构造函数和方法、声明了显式 `this` 类型的函数（例如 `function func(this: ThisType, ...)`），或定义在可以使用 `this` 的作用域中的箭头函数里使用 `this`。禁止用 `this` 指代全局对象、`eval` 的上下文、事件的目标，或不必要地被 `call()` 或 `apply()` 的函数。

### 原始字面量

普通字符串字面量必须用双引号（`"`）界定，与 Prettier 的 `singleQuote: false` 一致。字符串包含双引号字符时，允许用单引号界定，以避免转义该引号。

禁止在普通字符串字面量或模板字符串字面量中使用续行（在字面量内部用反斜杠结束一行）。必须改成拼接。拆开会妨碍搜索时，允许使用一条很长的字符串。

```
const LONG_STRING = "This is a very very very very very very long string. " +
        "It does not contain long stretches of spaces because it uses " +
        "concatenated strings.";
const SINGLE_STRING =
        "http://it.is.also/acceptable_to_keep_one_searchable_string";
```


涉及多个字符串字面量时必须使用模板字面量。模板字面量允许跨越多行。跨行时不必遵循外围块的缩进；多出来的空白无关紧要时允许遵循。

```
function arithmetic(a: number, b: number) {
    return `Here is a table of arithmetic operations:
${a} + ${b} = ${a + b}
${a} - ${b} = ${a - b}
${a} * ${b} = ${a * b}
${a} / ${b} = ${a / b}`;
}
```


数字允许用十进制、十六进制、八进制或二进制。十六进制、八进制和二进制必须精确使用小写前缀 `0x`、`0o` 和 `0b`。除非紧跟着 `x`、`o` 或 `b`，禁止前导零。

允许用 `String()` 和 `Boolean()`（禁止 `new`）、字符串模板字面量或 `!!` 做强制转换。枚举类型的值（包括枚举与其他类型的联合）禁止用 `Boolean()` 或 `!!` 转换成布尔值，必须用比较运算符显式比较。禁止用字符串拼接转换成字符串。

```
const bool = Boolean(0);
const str = String(aNumber);
const bool2 = !!str;
const str2 = `result: ${bool2}`;
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


必须检查任何数值强制转换的输出，并显式处理任何不抛异常的失败（包括 `NaN`）。禁止用一元加号（`+str`）或 `parseFloat` 把字符串转成数字。必须使用 `Number`。禁止使用 `parseInt`，除非需要非十进制基数。此时必须在解析前检查输入字符串的全部字符都是有效数字，并且必须对照 `NaN` 检查输出。

```
const x = Number(y);
if (!isFinite(x)) throw new Error(...);
```


禁止在 `if`、`for` 和 `while` 的条件里使用显式布尔强制转换。枚举类型的值（包括联合）禁止被隐式强制转换成布尔值，必须用比较运算符显式比较。其他类型允许隐式布尔强制转换，也允许用比较运算符显式比较。

```
// 长度需要和零比较时可以写成大于零，读者不用记住空数组在布尔上下文里算真还是算假。
if (arr.length > 0) {...}
// 数组长度也可以直接放进条件里，零是假值，非零是真值，和显式大于零的写法都允许，本例就是这样。
if (arr.length) {...}
```

```
const foo: MyInterface|null = ...;
if (foo) {...}
while (foo) {...}
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


### 控制结构

控制流语句始终为所含代码使用花括号块，即使主体只有一条语句。非空块的第一条语句必须从自己的一行开始。例外：能放在一行的 `if` 语句允许省略块。

```
for (let i = 0; i < x; i++) {
    doSomethingWith(i);
}

if (x) {
    doSomethingWithALongMethodNameThatForcesANewLine(x);
}
```

```
if (x) x.doFoo();
```


禁止在控制语句内部给变量赋值。确实必须在控制语句内部赋值时，必须把赋值放进额外的圆括号。

```
x = someFunction();
if (x) {
    // 这里省掉了和本条规则无关的语句，读者只需要看留下的那几行就能判断写法是否符合要求。
}
```

```
while ((x = someFunction())) {
    // 必须在循环条件里赋值时，用双层括号标明这是有意的赋值，而不是把等于号写成了赋值。
}
```


必须用 `for (... of someArr)` 迭代数组。`Array.prototype.forEach` 和普通 `for` 循环允许。`for`-`in` 只允许用于字典式对象。禁止用 `for (... in ...)` 迭代数组。`for`-`in` 中必须使用 `Object.prototype.hasOwnProperty` 排除原型属性。必须使用带 `Object.keys`、`Object.values` 或 `Object.entries` 的 `for`-`of`，禁止 `for`-`in`，除非没有这些替代。

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


只有当作者和评审者都认为，不加括号代码也不会被误读，而且加上括号也不会让代码更好读时，才允许省略可选的分组括号。禁止在 `delete`、`typeof`、`void`、`return`、`throw`、`case`、`in`、`of` 或 `yield` 后面的整个表达式外再加不必要的括号。

出现异常情况时必须使用异常。原生 `Error` 不够用时必须定义并使用自定义异常。必须抛出异常，禁止传入错误容器引用，也禁止返回带 error 属性的对象。

实例化异常时必须使用 `new Error()`，禁止直接调用 `Error()`。禁止抛出原始值（字符串、数字、`null` 或 `undefined`），也禁止抛出不是 `Error` 或其子类实例的对象。这条限制适用于所有可能抛出其参数的 API，包括 `Promise.reject` 和 `AbortSignal` 的 `abort` 方法。不带参数调用 `AbortController#abort` 或 `AbortSignal.abort` 允许，因为默认会创建 `DOMException` 并赋给 `reason`。

```
throw new Error("Foo is not a valid bar.");
```

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


捕获错误时必须假定所有抛出的错误都是 `Error` 的实例。禁止防御性地处理非 `Error` 类型，除非能够确凿地知道被调用的 API 会抛出非 `Error`。那时必须加注释，具体指出这些非 `Error` 从哪里来。禁止对大多数代码里不会出现的问题反复做同样的防御。

```
try {
    badApiThrowingStrings();
} catch (e: unknown) {
    // 这个 API 明确会抛出字符串而不是 Error，只有在这种已经证实的情况下才按字符串处理。
    if (typeof e === "string") { ... }
}
```


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


空的 `catch` 极少正确。确实完全不采取行动时，必须用注释说明为什么合理。禁止用空 `catch` 吞掉测试里的失败。必须改用 `assertThrows()`。

```
    try {
        return handleNumericResponse(response);
    } catch (e: unknown) {
        // 数值解析失败时落到文本处理。catch 里故意不改响应，只是换一条解析路径继续。
    }
    return handleTextResponse(response);
```


`ErrorOptions` 的 `cause` 必须用 `Error` 的子类型初始化。`cause` 的初始化器是类型为 `unknown` 的 `catch` 变量时，允许省略类型检查。禁止把一个 `Error` 对象直接当作 `ErrorOptions` 参数传入。

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
try {
    ...
} catch (e: unknown) {
    // 新的 Error 把原来的值放进 cause，这里不必再判断 e 是不是 Error 的子类。
    throw new Error("Something went wrong", {cause: e});
}
```


所有 `switch` 语句都必须包含 `default`，并且 `default` 必须放在最后，即使里面没有代码。每个非空语句组必须用 `break`、`return` 或抛出异常终止。禁止贯穿。空语句组允许贯穿。

```
switch (x) {
    case X:
    case Y:
        doSomething();
        break;
    default:  // 这个分支没有业务动作。空的 default 或空的 catch 必须说明为什么可以什么都不做。
}
```


```
switch (x) {
    case Y:
        doSomethingElse();
        break;
    default:
        // 这个分支没有业务动作。空的 default 或空的 catch 必须说明为什么可以什么都不做。
}
```


必须使用 `===` 和 `!==`。例外：与字面量 `null` 比较时，允许 `==` 和 `!=`，以便同时覆盖 `null` 和 `undefined`。

```
if (foo == null) {
    // foo == null 同时覆盖 null 和 undefined，这是严格相等之外少数允许的宽松比较。
}
```


```
if (foo === "bar" || baz !== bam) {
    // 正例用严格相等，null 和 undefined 不会被悄悄转成别的值，比较结果就是这两个值本身。
}
```


类型断言（`x as SomeType`）和不可空性断言（`y!`）禁止使用，除非有明显或明确的理由。必须改成执行该检查的运行时检查。断言安全只是因为局部性质时，必须加上说明。理由很明显时允许不加注释。

```
// 这里把 x 断言成 Foo。断言会绕过检查，所以前面的理由必须写清楚，不能只留下省略号。
(x as Foo).foo();

// 非空断言表示 y 在这里不可能是 null 或 undefined，注释要写出这个前提从哪来。
y!.bar();
```


```
// 下面的示例假定 Foo 是一个类，instanceof 才能用来收窄 x 的类型。
if (x instanceof Foo) {
    x.foo();
}

if (y) {
    y.bar();
}
```


类型断言必须使用 `as` 语法，禁止尖括号语法。双重断言必须经由 `unknown`，禁止经由 `any` 或 `{}`。对象字面量的类型必须用类型注解（`: Foo`），禁止用类型断言（`as Foo`）。

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


```
// 双重断言会绕过中间类型的检查，更要写明 x 为什么在这里可以当成 Foo，而不是别的类型。
(x as unknown as Foo).fooMethod();
```


```
// 把 z 断言成 Foo 后再读 length。注释要说明为什么 z 在这里一定是 Foo。
const x = (z as Foo).length;
```


必须限制 `try` 块里的代码量。不会抛出的行必须移出 `try`/`catch`。不会抛异常的内联调用允许留在里面。例外：`try` 块在循环内部时，允许把 `try` 块加宽到覆盖整个循环。

```
let result;
try {
    result = methodThatMayThrow();
} catch (error: unknown) {
    // 这里省掉了和本条规则无关的语句，读者只需要看留下的那几行就能判断写法是否符合要求。
}
use(result);
```


### 装饰器

禁止定义新的装饰器。只允许使用框架定义的装饰器：Angular（例如 `@Component`、`@NgModule`）和 Polymer（例如 `@property`）。装饰器必须紧挨在它所装饰的符号前面，中间禁止空行。

```
/**
 * 文档注释要写在装饰器前面，这样编辑器在装饰器元数据旁边也能显示这段说明，本例就是这样。
 */
@Component({...})  // 装饰器和类声明之间不要插空行，空行会让文档注释和类看起来不再相连，本例就是这样。
class MyComp {
    @Input() myField: string;  // 字段的装饰器可以和字段写在同一行，字段名仍然紧跟在装饰器后面，不必为了短装饰器换行。

    @Input()
    myOtherField: string;  // 装饰器参数变长时可以单独占一行，字段声明再换到下一行，两种写法不要在无故时混用。
}
```


### 不允许的特性

禁止实例化原始类型 `String`、`Boolean` 和 `Number` 的包装类。允许把包装类当作函数调用做强制转换，或用来创建符号。

禁止依赖自动分号插入。必须用分号显式结束所有语句。

禁止 `const enum`。必须改用普通的 `enum`。

生产代码禁止包含 `debugger` 语句。

禁止 `with`。

禁止 `eval` 或 `Function(...string)` 构造函数。代码加载器除外。

禁止非标准的 ECMAScript 或 Web 平台特性。这包括已弃用或已移除的旧特性、尚未标准化的新 ECMAScript 特性、当前 TC39 工作草案或仍在提案过程中的特性、尚未完成的 WHATWG 提案，以及非标准的语言扩展。只允许使用当前 ECMA-262 规范中定义的 ECMAScript 特性。针对特定 JavaScript 运行时的项目（仅最新 Chrome、Chrome 扩展、Node.JS、Electron）允许使用那些 API。专有且只在部分浏览器中实现的 API 必须先确认是否有公共库能把它抽象掉，否则禁止使用。

禁止修改内置类型，无论是往构造函数上还是往原型上添加方法。禁止依赖会这样做的库。除非第三方 API 要求，禁止往全局对象上添加符号。

## 命名

标识符只能使用 ASCII 字母、数字、下划线（用于常量和结构化的测试方法名），以及很少的 `$`。

名字禁止再装饰类型里已经包含的信息。禁止为私有属性或方法使用前导或尾随下划线。禁止为可选参数使用 `opt_` 前缀。禁止给接口做 `I` 前缀或 `Interface` 后缀，除非这在它所处的环境里是惯用做法。为类引入接口时，名字必须表达该接口当初为何存在（例如 `class TodoItem` 和 `interface TodoItemStorage`）。给 `Observable` 加 `$` 后缀是否使用由项目规定，项目内部必须一致。

名字必须对新读者具有描述性并且清楚。禁止对项目外读者含糊或陌生的缩写，也禁止删掉单词内部的字母来缩写。例外：作用域不超过 10 行的变量，包括不属于导出 API 的参数，允许使用短名字（例如单个字母）。

```
// 正例的名字按完整单词拼写，常见缩写只保留读者不用查表就能懂的那几个，其余单词写全。
errorCount  // errorCount 不删字母，读者不用猜 error 和 count 各自被砍掉了哪一部分。
dnsConnectionIndex  // DNS 是读者公认的缩写，可以留在 dnsConnectionIndex 里，后面的单词仍然写全。
referrerUrl  // URL 同样是公认缩写，referrerUrl 里保留它，不要展开成一长串单词。
customerId  // Id 在这个代码库里就是标识，customerId 不会被读成别的意思，不必改成 Identifier。
```


缩写必须当作完整单词处理，因此必须使用 `loadHttpUrl`，禁止 `loadHTTPURL`，除非平台名要求这样做（例如 `XMLHttpRequest`）。

标识符禁止使用 `$`，除非第三方框架的命名约定要求这样做。`Observable` 的 `$` 后缀见上文。

| 风格 | 类别 |
| --- | --- |
| `UpperCamelCase` | 类、接口、类型、枚举、装饰器、类型参数、TSX 中的组件函数、JSXElement 类型参数 |
| `lowerCamelCase` | 变量、参数、函数、方法、属性、模块别名 |
| `CONSTANT_CASE` | 全局常量值，包括枚举值 |
| `#ident` | 私有标识符禁止使用 |

类型参数允许单个大写字符（`T`），也允许 `UpperCamelCase`。

xUnit 风格测试方法名允许用 `_` 分隔，例如 `testX_whenY_doesZ()`。

下划线前缀只表示语法上必需、但不会被使用的标识符。允许在下划线后面提供有意义的名字，也允许单独一个 `_`。禁止对尾部未使用的参数使用这种风格，那些参数必须省略。专门打算被覆盖的方法允许保留尾部未使用的参数。标识符禁止使用 `_` 作为后缀。解构时必须用空位跳过中间元素，禁止再给被跳过的值命名。

```
[].filter(element => !element.hasSomeProperty());
```


```
(_projectId, api) => of(!params.disabledApis.includes(api));

[].filter((_, i) => i % 2 === 0);

for await (const _item of getAllTheThings()) {
    count++;
}

using _cleanupFoo = foo();
```


模块命名空间导入必须使用 `lowerCamelCase`，文件必须使用 `snake_case`。例外：jquery 使用 `$` 前缀，threejs 使用 `THREE` 前缀。

```
import * as fooBar from "./foo_bar";
```


`CONSTANT_CASE` 表示值意图不被更改，也允许用于技术上仍能被修改、但使用者不得修改的值。常量允许是类的 `static readonly` 属性。只有模块级声明的符号、模块级类的静态字段，以及模块级枚举的值，才允许 `CONSTANT_CASE`。程序生命周期内可以被实例化不止一次的值必须使用 `lowerCamelCase`。局部作用域别名必须使用现有标识符的格式。实现某个接口的箭头函数允许声明为 `lowerCamelCase`。

```
class Foo {
    private static readonly MY_SPECIAL_NUMBER = 5;

    bar() {
        return 2 * Foo.MY_SPECIAL_NUMBER;
    }
}
```


```
const UNIT_SUFFIXES = {
    "milliseconds": "ms",
    "seconds": "s",
};
// JavaScript 里这个对象仍然可以改，全大写是在告诉调用方不要修改单位后缀表。
```


局部别名必须与来源的现有命名和格式一致。变量的局部别名必须使用 `const`，类字段必须使用 `readonly`。为了暴露给框架模板而创建的别名必须加上合适的访问修饰符。

```
const {BrewStateEnum} = SomeType;
const CAPACITY = 5;

class Teapot {
    readonly BrewStateEnum = BrewStateEnum;
    readonly CAPACITY = CAPACITY;
}
```


覆盖、实现或收窄基类或接口成员的属性与方法，以及按上下文确定类型的对象字面量中的属性与方法，必须与现有声明的名字和大小写一致。大小写规则只适用于成员的原始声明。原始声明必须遵守这些规则，除非外部契约另有要求。可能时必须修正原始声明的名字。必须跟着外部契约走时，只允许在最初的声明上抑制命名检查，并且必须写明原因。

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

所有类型表达式允许依赖 TypeScript 编译器的类型推断。未导出的变量或参数初始化为 `string`、`number` 或 `boolean` 字面量时，必须省去类型注解。为了与 `isolatedDeclarations` 兼容而必须写出的导出符号类型注解，不得省去。显式泛型类型与类型注解重复时必须省去。更复杂的表达式是否加注解由代码评审者决定；评审者要求时必须加上。

```
// 左侧写成 string 数组之后，读者不用打开 transform 的实现也知道 value 里是什么。
const value: string[] = await rpc.getSomeValue().transform();
```


```
const x = new Set<string>();  // 局部变量优先让构造函数的类型参数推断元素类型，不必在左侧再写 Set<string>。
// 导出的绑定需要显式类型，右侧可以省略类型参数，由左侧的 Set<string> 约束。
export const y: Set<string> = new Set();
```


```
let count = 0;

// 正例给导出的常量写上 string，隔离声明可以不看初始值就发出类型，模板怎么拼不影响声明。
export const PATH: string = `/users/${id}`;
```


```
const x = 15;  // 局部变量的类型可以从 15 推断出来，不必在左侧再写一遍 number，注解在这里是重复的。
```


函数和方法是否包含返回类型注解由代码作者决定。评审者可以要求加上注解，以说清难以理解的复杂返回类型。项目允许有本地策略始终要求返回类型，但这不是一般的 TypeScript 风格要求。

允许用 `undefined` 或 `null` 表示值的缺失。没有统一要求必须优先哪一个；必须跟随所调用 API 的上下文。

类型别名禁止在联合类型中包含 `|null` 或 `|undefined`。只允许在别名真正被使用的位置加上它们。必须在 null 值产生的附近处理它们。

```
// 正例让返回类型在方法上写成可能缺失，类型别名本身只表示确实存在的咖啡种类，本例就是这样。
type CoffeeResponse = Latte|Americano;

class CoffeeService {
    getLatte(): CoffeeResponse|undefined { ... };
}
```


提供基于结构的实现时，必须在符号的声明处显式写上类型。定义结构类型必须用接口，禁止用类。

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
const foo: Foo = {
    a: 123,
    b: "abc",
}
```


为对象声明类型时必须使用接口，禁止使用对象字面量表达式的类型别名。

```
interface User {
    firstName: string;
    lastName: string;
}
```


对只包含字母数字字符和点的简单类型，必须使用 `T[]` 或 `readonly T[]`，禁止 `Array<T>` 或 `ReadonlyArray<T>`。简单类型的多维非 `readonly` 数组必须使用 `T[][]` 这种语法糖。任何更复杂的类型必须使用 `Array<T>`。这些规则适用于每一层嵌套：嵌在更复杂类型里的简单 `T[]` 仍然必须写成 `T[]`。

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


索引签名必须为键提供有意义的标签。必须使用 ES6 的 `Map` 和 `Set`，除非索引签名才能表达该结构。键是静态已知的一组时，必须使用 `Record<Keys, ValueType>`，禁止把它写成关联数组。

```
const fileSizes: {[fileName: string]: number} = {};
fileSizes["readme.txt"] = 541;
```

```
const users: {[userName: string]: number} = ...;
```


必须使用能够表达代码的最简单类型构造。能用接口扩展表达时必须使用接口扩展，禁止用映射类型或条件类型换取简短。在最简单构造仍然不够时，允许映射类型与条件类型。

```
interface FoodPreferences {
    favoriteIcecream: string;
    favoriteChocolate: string;
}
```

```
// 这里的 FoodPreferences 与上面选出的两种食物字段相同，示例不再把字段重复写一遍。
interface FoodPreferences { }
interface User extends FoodPreferences {
    shoeSize: number;
    // User 扩展了食物偏好，因此除了鞋码还包含冰淇淋和巧克力这两个字段，调用方能直接读取。
}
```


禁止使用 `any`，除非不能提供更具体的类型、不能使用 `unknown`，也不能用带记录的静态检查抑制来代替。正当使用 `any`（例如测试里的模拟对象）时，必须加上抑制静态检查警告的注释，并记录为什么正当。使用 `unknown` 之后，必须用类型守卫收窄，禁止在收窄前解引用属性。

```
// 这个测试只需要 BookService 的一部分。缺方法时测试会明显失败，所以这里有意做成不安全的部分替身。
// tslint:disable-next-line:no-any
const mockBookService = ({get() { return mockBook; }} as any) as BookService;
// 这个测试不会触碰购物车，用 any 占住构造参数只是为了满足签名，不代表购物车可以被随便替换。
// tslint:disable-next-line:no-any
// 购物车参数在这个测试里不会被读取，保留空值只是为了把构造函数的参数位置填上，本例就是这样。
const component = new MyComponent(mockBookService, null as any);
```


```
// unknown 可以接住任何值，包括 null 和 undefined，但在收窄或断言之前不能读取它的属性。
const val: unknown = value;
```


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


大多数用例禁止 `{}`。必须改用 `unknown`（任何值，包括 `null` 或 `undefined`）、`Record<string, T>`（字典式对象）或 `object`（排除原始类型，只留下非空的函数和对象）。

禁止为了成对值去声明 `Pair` 接口，必须使用元组类型。需要有意义的属性名时必须使用接口；接口过重时必须使用内联对象字面量类型。

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


```
function splitInHalf(input: string): [string, string] {
    ...
    return [x, y];
}

// 调用方按元组的位置拆开返回值，左边是前半段，右边是后半段，顺序必须和声明一致，本例就是这样。
const [leftHalf, rightHalf] = splitInHalf("my string");
```


禁止使用包装类型 `String`、`Boolean`、`Number` 和 `Object`。必须使用 `string`、`boolean`、`number`。用 `{}` 表示除 `null` 和 `undefined` 以外的一切，或用小写 `object` 进一步排除 `string`、`boolean`、`number`、`symbol` 和 `bigint`。禁止把包装类型当作构造函数调用。

禁止创建只有返回类型泛型的 API。使用已有的、只有返回类型泛型的 API 时，必须显式指定泛型。

## 工具链要求

所有 TypeScript 文件都必须使用标准工具链通过类型检查。

禁止 `@ts-ignore`、`@ts-expect-error` 和 `@ts-nocheck`。单元测试中允许 `@ts-expect-error`，但禁止把它当作通常做法，因为它会抑制所有错误。必须改成转换成期望的类型或 `any` 并加上解释性注释，或抑制静态检查警告并记录原因。

必须遵守任何适用的全局或框架本地一致性规则，包括 tsetse 和 tsec。

## 注释与文档

用开闭分隔符各自独占一行的 JSDoc 块编写供代码使用者阅读的文档。用 `//` 行注释做实现注释。每条注释都用中文。产品名 VeriQ 和技术标识允许保持原文。每行须遵守[显示列宽要求](../coding-standard.md#11-显示列宽的统一计算)，超出部分必须换行。

多行实现注释必须与周围代码缩进在同一层级，并且必须使用多条 `//`，禁止 `/* */`。禁止用星号或其他字符把注释画成方框。

```
// 多行实现注释用连续的双斜线，每行单独成注释，不要改成会把说明包成一块的块注释，本例就是这样。
```


JSDoc 必须始终把 `/**` 和 `*/` 各自放在独占行，正文从下一行的 ` * ` 开始。即使原先能放进单行也必须展开。
JSDoc 首行有效正文和续行按[注释正文长度](../coding-standard.md#12-注释正文长度)计算。

```
/**
 * 多行文档按普通句子换行，参数标签各自独占一行，不要把说明和标签挤在同一行里，本例就是这样。
 * @param arg 交给函数处理的数字，调用方要保证它是有限数值。
 */
function doSomething(arg: number) { … }
```


JSDoc 必须用 Markdown 书写，允许包含 HTML。列表必须写成 Markdown 列表。

```
/**
 * 重量由下面三项一起决定，列表必须写成 Markdown，文档工具才会保留项目符号。
 *
 * - 发出的件数
 * - 收到的件数
 * - 最后一次的时间戳
 */
```


```
/**
 * 这个函数按参数完成一次转换，文档要说明转换结果交给谁，而不是只把函数名再说一遍。
 */
function doSomething(arg: number) { … }
```


大多数 JSDoc 标签必须独占一行，并且位于行首。换行后的块标签必须缩进四个空格。换行后的描述文字禁止与前面几行做水平对齐。换行 `@desc` 或 `@fileoverview` 描述时禁止缩进。

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


```
/**
 * 参数标签必须各自独占一行，不能把两个 @param 写在同一行，解析器无法拆开两段说明。
 * @param left 加法的左操作数，调用方传入已经对齐单位的数字。
 * @param right 加法的右操作数，单位必须和左操作数相同。
 */
function add(left: number, right: number) { ... }
```


必须为所有顶层导出写 `/** JSDoc */`。禁止仅仅复述属性或参数的名字。目的不能从名字立即看出来的属性和方法，无论是否导出，都必须写文档；是否立即明显由评审者判断。例外：只为了被工具消费而导出的符号，例如 `@NgModule` 类，不需要注释。

类的 JSDoc 必须说明如何以及何时使用该类，以及正确使用所需的额外考虑。构造函数上允许省略文字描述。

方法描述、参数和返回值从该方法其余的 JSDoc，或从方法名和类型签名就能看出来时，允许省略。方法描述必须使用中文。方法的 JSDoc 仍须遵守[正文长度](../coding-standard.md#12-注释正文长度)与[显示列宽](../coding-standard.md#11-显示列宽的统一计算)要求。必须描述方法做什么。禁止照抄英文的 “This method …” 前缀。

参数属性必须用 JSDoc 的 `@param` 注解写文档。禁止在 `@param` 或 `@return` 里声明类型。禁止在已经使用 `implements`、`enum`、`private`、`override` 等关键字的代码上再写对应的 JSDoc 标签。

```
/**
 * 这个类演示参数属性的文档写在构造函数的参数标签上，而不是写在类体里的字段旁边，本例就是这样。
 */
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
/**
 * 这个类演示普通字段的文档直接写在字段上方，而不是写进构造函数的参数列表里，本例就是这样。
 */
class OrdinaryClass {
    /**
     * 下一次调用 brew 时会使用的咖啡豆。替换这个字段，就会改变下一次冲煮所用的原料。
     */
    nextBean: CoffeeBean;

    constructor(initialBean: CoffeeBean) {
        this.nextBean = initialBean;
    }
}
```


禁止只复述参数名和类型的注释。`@param` 和 `@return` 只在增加信息时才允许出现，否则必须省略。

```
/**
 * 向冲煮服务发送启动请求，并按升数准备这一壶咖啡，调用方传入的升数不能超过壶的容量。
 * @param amountLitres 本次冲煮的升数，必须能装进当前壶的容量，超出时调用方要先减少用量。
 */
brew(amountLitres: number, logger: Logger) {
    // 这里省掉了和本条规则无关的语句，读者只需要看留下的那几行就能判断写法是否符合要求。
}
```


方法名和参数值不足以传达参数含义时，必须使用参数名注释。添加之前必须把方法重构为接受一个接口并解构它，除非这样做不可行。参数名注释放在参数值之前，包含参数名和 `=` 后缀。同一文件内已有把注释放在参数值之后并省略 `=` 的遗留风格时，允许在该文件内继续使用这种风格。

```
// 调用点在值前面或值后面重复参数名，因为只看 true 和字符串看不出它们对应 shouldRender 还是 name。
someFunction(obviousParam, true /* shouldRender */, "hello" /* name */);
```


```
// 调用点在值前面或值后面重复参数名，因为只看 true 和字符串看不出它们对应 shouldRender 还是 name。
someFunction(obviousParam, /* shouldRender= */ true, /* name= */ "hello");
```


类、方法或属性同时有装饰器和 JSDoc 时，JSDoc 必须写在装饰器之前。禁止把 JSDoc 写在装饰器和被装饰语句之间。

```
/**
 * 这个组件把模板里的 bar 渲染出来，文档要放在装饰器之前，编辑器才能在选择器旁显示说明。
 */
@Component({
    selector: "foo",
    template: "bar",
})
export class FooComponent {}
```


## 策略

本规范没有明确解决的风格问题，必须按同一文件中其他代码已经在做的方式去做。这样仍不能解决时，必须仿照同一目录中的其他文件。

全新文件必须使用本指南的风格，无论同一包中其他文件做了什么。往一个不符合本指南的文件里添加新代码时，必须先重新格式化现有代码。不做这种重新格式化时，新代码必须尽可能与同一文件中的现有代码保持一致，但禁止违反本指南。

不要求把所有现有代码都改成符合当前风格。对一个文件做了重大修改时，该文件必须符合本指南。与变更焦点无关的大量风格修改必须拆到单独的变更里。

已弃用的方法、类或接口必须用 `@deprecated` 标记。弃用注释必须包含简单、清楚的说明，告诉人们如何修复调用点。

构建过程生成的源代码不要求符合本指南。任何会从手写源代码引用的生成标识符都必须遵守命名要求。这类标识符允许包含下划线。

代码必须导入它使用的库。
