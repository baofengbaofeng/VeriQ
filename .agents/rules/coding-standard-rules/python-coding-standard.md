# Python coding standard

下面的 VeriQ 改编是规范性的，与 Google 原文不一致时以这里为准。本风格指南列出 Python 程序必须遵守和必须避免的做法。

- 代码块使用 4 个空格缩进。禁止使用 Tab。文档字符串的悬挂缩进是 4 个空格。
- 代码、导入语句和注释均须遵守[显示列宽要求](../coding-standard.md#11-显示列宽的统一计算)。
- 注释，包括文档字符串和行内说明，使用中文。产品名 VeriQ 和技术标识允许保持原文。
- 注释须遵守[正文长度要求](../coding-standard.md#12-注释正文长度)。说明这段代码在做什么，禁止用口号凑长度。
- 静态检查必须使用 pylint，并配合 pylintrc。格式化必须使用 Black 或 Pyink。

## 1 背景

Python 程序必须遵守本文件的必须项，禁止本文件的禁止项。解释器只使用 Python 3.12。

## 2 Python 语言规则

### 2.1 静态检查

必须用 pylintrc 对代码运行 pylint。

不恰当的警告必须抑制，以免其他问题被淹没。抑制必须使用行级 `pylint: disable`。禁止使用已废弃的 `pylint: disable-msg`。Google 专用警告以 `g-` 开头。符号名看不出原因时，必须另写说明。

```
# WSGI 要求方法名保持 do_PUT 这种协议拼写，因此只在这一行关掉 invalid-name，不把方法改成蛇形。
def do_PUT(self):  # pylint: disable=invalid-name
    ...
```

未使用参数必须在函数开头用 `del` 删除，并附中文注释。该注释块的首行有效正文须遵守[正文长度要求](../coding-standard.md#12-注释正文长度)。禁止只用 “Unused.”。把未使用参数写成 `_`、加上 `unused_` 前缀，或赋给 `_`，仍然允许；新代码禁止使用这些写法，因为它们破坏按名字传参，也不能强制参数真的未被使用。

```
def viking_cafe_order(spam: str, beans: str, eggs: str | None = None) -> str:
    del beans, eggs  # 维京人这份订单不读取豆子和鸡蛋，删掉它们是为了标明参数未使用，而不是改成空字符串。
    return spam + spam + spam
```


### 2.2 导入

`import` 只用于导入包和模块，禁止导入单个类型、类或函数。下列模块中用于静态分析和类型检查的符号除外：`typing`、`collections.abc`、`typing_extensions`。

必须使用下列形式之一：

- `import x`，用于导入包和模块。
- `from x import y`，其中 `x` 是包前缀，`y` 是不带前缀的模块名。
- `from x import y as z`，仅当要导入两个都叫 `y` 的模块、`y` 与当前模块顶层名字冲突、`y` 与公共 API 的常见参数名冲突（例如 `features`）、`y` 长得不方便，或在上下文里 `y` 太笼统。
- `import y as z` 仅当 `z` 是标准缩写（例如 `import numpy as np`）。

禁止相对导入。即使模块在同一个包里，也必须使用完整包名。

```
from sound.effects import echo
...
echo.EchoFilter(input, output, delay=0.7, atten=4)
```


### 2.3 包

所有新代码必须按模块的完整路径导入每个模块。禁止假定主程序所在目录位于 `sys.path`。`import jodie` 必须视为名为 `jodie` 的第三方或顶层包，而不是本地的 `jodie.py`。

```
# 这里用完整模块名 absl.flags 引用旗标，读者不用猜 flags 是从哪一个包导入的。
import absl.flags
from doctor.who import jodie

_FOO = absl.flags.DEFINE_string(...)
```

```
# 从 absl 导入 flags 模块后，用模块名调用即可，不必每次写出 absl.flags 这个完整前缀。
from absl import flags
from doctor.who import jodie

_FOO = flags.DEFINE_string(...)
```


### 2.4 异常

允许使用异常，并且必须遵守下列条件：

- 合适时必须使用内置异常类。编程错误（例如违反前置条件）必须使用 `ValueError`。
- 禁止用 `assert` 代替条件判断或前置条件校验。`assert` 不得成为应用逻辑的关键部分。删掉 `assert` 之后代码必须仍然成立。`assert` 中的条件不保证会被求值。基于 pytest 的测试里，用 `assert` 核对预期是必须的做法。
- 库或包定义自己的异常时，必须继承已有的异常类。异常名必须以 `Error` 结尾，并且不得重复（禁止 `foo.FooError` 这种重复）。
- 禁止使用笼统的 `except:`，也禁止捕获 `Exception` 或 `StandardError`，除非重新抛出该异常，或在程序里建立隔离点：异常不继续传播，而是被记录并抑制，例如在线程最外层拦住异常，避免线程崩溃。
- `try` 块必须缩到最小。
- 无论 `try` 块是否抛出异常都要运行的代码，必须放在 `finally`。

```
def connect_to_next_port(self, minimum: int) -> int:
    """从调用方传入的端口下限开始寻找，连上下一个可用端口之后，把新端口交还给调用方，本例就是这样。

    Args:
        minimum: 端口下限，必须大于或等于 1024。
    Returns:
        实际连上的新端口，作为下一次搜索的下限。
    Raises:
        ConnectionError: 从下限往上找不到可以连接的端口。
    """
    if minimum < 1024:
        # 这里抛出 ValueError 是因为调用方违反了端口下限，文档的 Raises 不承诺这种误用会得到哪一种具体异常。
        raise ValueError(f'Min. port must be at least 1024, not {minimum}.')
    port = self._find_next_open_port(minimum)
    if port is None:
        raise ConnectionError(
                f'Could not connect to service on port {minimum} or higher.')
    # 后面的逻辑不依赖这条 assert 的结果，它只在开发时确认端口没有小于调用方给出的下限。
    assert port >= minimum, (
            f'Unexpected port {port} when minimum was {minimum}.')
    return port
```


### 2.5 可变全局状态

禁止可变的全局状态。

例外：确实有理由时，可变全局实体必须声明在模块级或作为类属性，名字前加 `_`。外部访问必须通过公开函数或类方法。注释或注释所链到的文档必须说明为什么使用可变全局状态。

模块级常量必须使用，并且必须使用全大写加下划线的名字。

### 2.6 嵌套、局部与内部的类和函数

需要闭合局部变量时允许嵌套局部函数或类。内部类允许。

除了闭合 `self` 或 `cls` 以外的局部值，禁止嵌套函数或类。禁止只为了对模块使用者隐藏某个函数而把它嵌进去。必须在模块级给它的名字加上 `_` 前缀，以便测试访问。

### 2.7 推导式与生成器表达式

允许简单的列表、字典、集合推导式和生成器表达式。映射表达式、`for` 子句和过滤表达式各自必须能放在一行里。禁止多个 `for` 子句，也禁止多个过滤表达式。复杂情况必须改用循环。可读性优先于简短：复杂时必须改用循环，禁止为了简短保留难读的推导式。

```
result = [mapping_expr for value in iterable if filter_expr]

result = [
        is_valid(metric={'key': value})
        for value in interesting_iterable
        if a_longer_filter_expression(value)
]

descriptive_name = [
        transform({'key': key, 'value': value}, color='black')
        for key, value in generate_iterable(some_input)
        if complicated_condition_is_met(key, value)
]

result = []
for x in range(10):
    for y in range(5):
        if x * y > 10:
            result.append((x, y))

return {
        x: complicated_transform(x)
        for x in long_generator_function(parameter)
        if x is not None
}

return (x**2 for x in range(10))

unique_names = {user.name for user in users if user is not None}
```


### 2.8 默认迭代器与运算符

对支持它们的类型（列表、字典、文件等）必须使用默认迭代器和成员测试运算符（`in`、`not in`）。必须使用迭代器方法，禁止为了迭代去调用返回列表的方法。迭代容器时禁止修改它。

```
for key in adict: ...
if obj in alist: ...
for line in afile: ...
for k, v in adict.items(): ...
```


### 2.9 生成器

需要时必须使用生成器。生成器函数的文档字符串必须使用 `Yields:`，禁止使用 `Returns:`。

生成器管理昂贵资源时必须强制清理，并且必须用上下文管理器包住生成器（PEP 533）。

### 2.10 Lambda 函数

单行 lambda 允许。带 `lambda` 的 `map()` 或 `filter()` 禁止使用，必须改成生成器表达式。对乘法这类常见运算，必须使用 `operator` 模块里的函数，禁止用 lambda。

lambda 的代码跨越多行，或长于 60 到 80 个字符时，必须改成普通的嵌套函数。

### 2.11 条件表达式

简单情况允许使用条件表达式。真值表达式、`if` 表达式和 `else` 表达式各自必须放在一行里。变复杂时必须使用完整的 `if` 语句。

```
one_line = 'yes' if predicate(value) else 'no'
slightly_split = ('yes' if predicate(value)
                  else 'no, nein, nyet')
the_longest_ternary_style_that_can_be_done = (
    'yes, true, affirmative, confirmed, correct'
    if predicate(value)
    else 'no, false, negative, nay')
```


### 2.12 默认参数值

多数情况允许默认参数值。禁止在函数或方法定义里把可变对象用作默认值。默认参数在模块加载时只求值一次，因此也禁止把会在加载时固定下来、随后应当变化的值（例如 `time.time()` 或尚未解析的旗标值）用作默认值。

```
def foo(a, b=None):
    if b is None:
        b = []
def foo(a, b: Sequence | None = None):
    if b is None:
        b = []
# 空元组不可变，拿它当默认值不会在多次调用之间被改掉，调用方每次看到的都是同一个空元组。
def foo(a, b: Sequence = ()):
    ...
```


### 2.13 属性

属性只允许用于只需少量计算或逻辑的读取和设置。实现必须符合普通属性访问的预期：便宜、直接、不出人意料。禁止用属性仅仅同时读写一个内部属性。允许用属性控制访问，或计算轻易能得出的派生值。

属性必须用 `@property` 创建。手工实现属性描述符属于高级特性，按 2.19 禁止。禁止用属性实现子类将来可能想覆盖并扩展的计算。

### 2.14 真与假的求值

必须使用隐式假，例如 `if foo:`。下列例外是强制的：

- 检查 `None` 时必须使用 `if foo is None:` 或 `is not None`。
- 禁止用 `==` 把布尔变量和 `False` 比较。必须使用 `if not x:`。需要区分 `False` 和 `None` 时，必须把表达式串起来，例如 `if not x and x is not None:`。
- 对序列（字符串、列表、元组）必须利用空序列为假。禁止用 `len(seq)` 代替 `if seq:` 或 `if not seq:`。
- 已知是整数、且不是 `len()` 结果的值，必须与整数 `0` 比较。
- 字符串 `'0'` 为真，不得把它当成假。
- 测试 `np.array` 是否为空时必须使用 `.size`（例如 `if not users.size`）。禁止把 Numpy 数组直接放进隐式布尔上下文。

```
if not users:
    print('no users')

if i % 10 == 0:
    self.handle_multiple_of_ten()

def f(x=None):
    if x is None:
        x = []
```


禁止用 `x = x or []` 代替对 `None` 的显式判断。

### 2.16 词法作用域

允许嵌套函数按词法作用域读取外层函数的变量。块里对某个名字的赋值会使该名字的全部引用成为局部变量。`global` 声明使该名字成为全局变量。禁止依赖这种赋值来读取外层同名变量。

```
def get_adder(summand1: float) -> Callable[[float], float]:
    """返回的闭包会把后来传入的数加到构造时给定的加数上，加数在闭包创建时就已经固定，本例就是这样。
    """
    def adder(summand2: float) -> float:
        return summand1 + summand2

    return adder
```


### 2.17 函数与方法装饰器

有明显好处时允许使用装饰器，并且必须遵守下列限制：

- 装饰器必须遵循与函数相同的导入和命名准则。
- 装饰器的文档字符串必须明确说明该函数是装饰器。
- 必须为装饰器编写单元测试。
- 装饰器自身禁止外部依赖（文件、套接字、数据库连接等）。用有效参数调用的装饰器必须在所有情况下成功。
- 除非为了接入现有库所定义的 API 而被迫使用，禁止 `staticmethod`。必须改写为模块级函数。
- 只有在编写具名构造器，或编写会修改必要全局状态（例如进程范围的缓存）的类专用例程时，才允许 `classmethod`。

```
class C:
    @my_decorator
    def method(self):
        # 方法体在此省略，这个示例只关心装饰器写在 def 的上方，而不是装饰之后再赋回。
```


### 2.18 线程

禁止依赖内置类型的原子性，也禁止依赖变量赋值的原子性。

线程之间传递数据必须使用 `queue` 模块的 `Queue`。无法使用 `Queue` 时必须使用 `threading` 模块及其锁原语，并且必须使用 `threading.Condition`，禁止更底层的锁。

### 2.19 高级特性

禁止自定义元类、访问字节码、即时编译、动态继承、对象重新指定父类、导入技巧、反射（例如 `getattr()` 的某些用法）、修改系统内部，以及用 `__del__` 实现定制清理。

标准库里内部使用这些特性的模块和类允许使用，例如 `abc.ABCMeta`、`dataclasses` 和 `enum`。

### 2.20 现代 Python：from __future__ 导入

VeriQ 的 Python 解释器只使用 3.12。`generator_stop` 在 3.12 已是语言默认行为：生成器里冒出来的 `StopIteration` 会变成 `RuntimeError`。因此禁止写 `from __future__ import generator_stop`，也禁止为了更早的解释器保留这行导入。

其他 `from __future__` 导入只在 3.12 仍然需要时允许使用，例如 `annotations`，用来推迟注解求值。

### 2.21 带类型注解的代码

必须用类型提示给 Python 代码加注解。构建时必须用 pyrefly 这类类型检查工具检查代码。可行时类型注解必须写在源文件里。第三方或扩展模块的注解必须放在存根 `.pyi` 文件里。

```
def func(a: int) -> list[int]:
```

```
a: SomeType = some_func()
```


添加或修改公共 API 时必须加上类型注解，并在构建系统里启用类型检查。无法采用时，必须在 BUILD 文件或代码里加上带 TODO 的注释，或链接到描述阻碍的缺陷。

## 3 Python 风格规则

### 3.1 分号

禁止用分号结束一行，也禁止用分号把两条语句放在同一行。

### 3.2 行宽

代码行和注释行须遵守[显示列宽要求](../coding-standard.md#11-显示列宽的统一计算)，注释正文超出后必须换行。注释块首行有效正文须含中文，并遵守[正文长度要求](../coding-standard.md#12-注释正文长度)。文档字符串的中文摘要也适用这两项要求，见[文档字符串](#381-文档字符串)。

显示列宽上限也适用于导入语句、长字符串常量、机器指令、注释里的 URL，以及格式化工具无法压进行宽的行。格式化工具压不进去时，必须改写表达式或拆开语句。

禁止用反斜杠做显式续行。必须利用圆括号、方括号和花括号内的隐式续行。必要时必须在表达式外再加一对圆括号。字符串内部用反斜杠转义的换行不受本条禁止。

```
foo_bar(self, width, height, color='black', design=None, x='foo',
        emphasis=None, highlight=0)
```

```
if (width == 0 and height == 0 and
    color == 'red' and emphasis == 'strong'):

(bridge_questions.clarification_on
 .average_airspeed_of.unladen_swallow) = 'African or European?'

with (
    very_long_first_expression_function() as spam,
    very_long_second_expression_function() as beans,
    third_thing() as eggs,
):
    place_order(eggs, beans, spam, beans)
```


字面字符串一行放不下时，必须用圆括号做隐式续行。必须在尽可能高的语法层次断行。必须断两次时，两次都必须在同一语法层次断开。

```
bridgekeeper.answer(
    name="Arthur", quest=questlib.find(owner="Arthur", perilous=True))

answer = (a_long_line().of_chained_methods()
          .that_eventually_provides().an_answer())

if (
    config is None
    or 'editor.language' not in config
    or config['editor.language'].use_spaces is False
):
    use_tabs()
```


```
x = ('This will build a very long long '
     'long long long long long long string')
```


注释里的 URL 允许单独占一行，仍须遵守[显示列宽要求](../coding-standard.md#11-显示列宽的统一计算)。禁止用反斜杠把 URL 从中间截断。

```
# 字段的完整说明放在下一行的链接里，链接本身不要从中间折断，否则读者无法直接打开。
# 规范链接单独占一行，读者和工具都能整段复制，不用把被折断的路径再拼回去，本例就是这样。
# http://www.example.com/us/developer/documentation/api/content/v2.0/csv_file_name_extension_specification.html
```


### 3.3 圆括号

禁止不必要的圆括号。元组外面允许使用圆括号。除非为了隐式续行或为了标明元组，禁止在 `return` 语句或条件语句里使用圆括号。单元素元组必须写成带括号和尾随逗号的形式，例如 `(foo,)`。

```
if foo:
    bar()
while x:
    x = bar()
if x and y:
    bar()
if not x:
    bar()
# 单元素元组靠括号比靠末尾逗号更容易看出来，读者不容易把它当成一个普通表达式，本例就是这样。
onesie = (foo,)
return foo
return spam, beans
return (spam, beans)
for (x, y) in dict.items(): ...
```


### 3.4 缩进

代码块使用 4 个空格缩进。禁止使用 Tab。

隐式续行必须把换行后的元素与开分隔符后的内容垂直对齐，或使用 4 个空格的悬挂缩进。禁止在同一次调用里混用两种对齐。禁止使用 2 个空格的悬挂缩进。闭合的圆括号、方括号或花括号允许放在表达式末尾，也允许单独成行；单独成行时必须与对应开括号所在行缩进相同。字典的值换到下一行时，必须相对键再悬挂缩进 4 个空格。

```
# 续行与开括号之后的第一个参数对齐，读者能看出这些参数属于同一次函数调用，本例就是这样。
foo = long_function_name(var_one, var_two,
                         var_three, var_four)
meal = (spam,
        beans)

# 字典的续行与开括号后的内容对齐，较长的键值表达式仍能看出属于同一个字面量，本例就是这样。
foo = {
    'long_dictionary_key': value1 +
                           value2,
    ...
}

# 第一行不放参数，换行后用四个空格悬挂缩进，闭括号可以跟在最后一项的后面，本例就是这样。
foo = long_function_name(
    var_one, var_two, var_three,
    var_four)
meal = (
    spam,
    beans)

# 第一行不放参数，悬挂缩进四个空格，闭括号单独成行，并与开头的那一行对齐，本例就是这样。
foo = long_function_name(
    var_one, var_two, var_three,
    var_four
)
meal = (
    spam,
    beans,
)

# 字典的值换到下一行时，相对键再悬挂缩进四个空格，不要和键挤在同一列里，本例就是这样。
foo = {
    'long_dictionary_key':
        long_dictionary_value,
    ...
}
```


#### 3.4.1 项目序列中的尾随逗号

只有当闭合容器记号 `]`、`)` 或 `}` 与最后一项不在同一行时，项目序列才必须使用尾随逗号。二者在同一行时禁止尾随逗号。单元素元组必须使用尾随逗号。最后一项后面有 `,` 时，Black 或 Pyink 必须把该容器格式化成每项一行。

```
golomb3 = [0, 1, 3]
golomb4 = [
    0,
    1,
    4,
    6,
]
```


### 3.5 空行

顶层函数定义和类定义之间必须空两行。方法定义之间必须空一行，`class` 的文档字符串与第一个方法之间也必须空一行。`def` 行后面禁止空行。函数或方法内部的单行空行没有统一数量。紧挨定义之前的相关注释允许不紧贴空行；能放进文档字符串的说明必须放进文档字符串。

### 3.6 空白

圆括号、方括号或花括号内部禁止空白。逗号、分号或冒号之前禁止空白。逗号、分号或冒号之后必须有空白，行尾除外。开始参数列表、索引或切片的开括号之前禁止空白。禁止行尾空白。

```
spam(1)
```

```
dict['key'] = list[index]
```


```
if x == 4:
    print(x, y)
x, y = y, x
```


```
spam(ham[1], {'eggs': 2}, [])
```


二元运算符两侧必须各留一个空格，用于赋值（`=`）、比较（`==`、`<`、`>`、`!=`、`<>`、`<=`、`>=`、`in`、`not in`、`is`、`is not`）和布尔运算（`and`、`or`、`not`）。算术运算符（`+`、`-`、`*`、`/`、`//`、`%`、`**`、`@`）两侧的空格没有统一要求。

```
x == 1
```


传递关键字参数或定义默认参数值时，禁止在 `=` 周围加空格。例外：存在类型注解时，默认参数值的 `=` 周围必须加空格。

```
def complex(real, imag=0.0): return Magic(r=real, i=imag)
def complex(real, imag: float = 0.0): return Magic(r=real, i=imag)
```


禁止用空格把连续行上的记号垂直对齐（适用于 `:`、`#`、`=` 等）。行尾注释与代码之间只留两个空格。

```
foo = 1000  # 行尾注释说明这个赋值的含义，和代码之间只留两个空格，不要为了竖齐去垫空格，本例就是这样。
long_name = 2  # 这条注释故意不和上一行的注释竖齐，竖齐会在改名时制造无关的空白差异，本例就是这样。

dictionary = {
        'foo': 1,
        'long_name': 2,
}
```


### 3.7 Shebang 行

大多数 `.py` 文件禁止以 `#!` 行开头。只有打算直接执行的文件必须有 shebang。程序的主文件必须以 `#!/usr/bin/env python3` 开头以支持虚拟环境，或按 PEP 394 以 `#!/usr/bin/python3` 开头。

### 3.8 注释与文档字符串

模块、函数、方法的文档字符串和行内注释必须使用本节的格式。

#### 3.8.1 文档字符串

文档字符串是包、模块、类或函数中的第一条语句。必须使用三个双引号 `"""`（PEP 257）。摘要必须在一个物理行内用中文写成，以 `。`、`？` 或 `！` 结尾，并遵守[首行正文长度](../coding-standard.md#12-注释正文长度)与[整行显示列宽](../coding-standard.md#11-显示列宽的统一计算)要求。再写更多内容时，后面必须空一行，其余部分必须从第一行第一个引号所在的同一列开始。

#### 3.8.2 模块

每个文件必须包含项目许可证样板。文件必须以描述模块内容和用法的文档字符串开头。

```
"""用中文说明这个模块提供什么能力，以及调用方应该从哪里进入，不要只重复文件名，本例就是这样。

空一行之后再写整体行为。需要时补充导出的类、函数，并给出最短的调用示例。

    foo = ClassFoo()
    bar = foo.function_bar()
"""
```


测试模块不需要模块级文档字符串。`unittest.TestCase` 的子类不需要类文档字符串，其子类中的 `test_` 方法不需要方法文档字符串。只重复类名或方法名的文档字符串必须省略。文档字符串提供额外信息时必须写上，例如说明测试应如何运行，或解释不寻常的准备方式或外部依赖。不提供任何新信息的文档字符串禁止使用。

```
"""这个测试把黄金文件当作期望输出，失败时要对照那些文件，而不是只看断言文本，本例就是这样。

更新黄金文件需要显式带上 --update_golden_files，不要在普通运行里改写期望结果。
"""
```

```
def test_foo_is_barred(self):
    """这个测试固定的是 bar 会作用到 foo 上，而不是只确认测试方法能被收集到。
    """
```


#### 3.8.3 函数与方法

本节的“函数”指方法、函数、生成器或属性。

具有下列任一性质的每个函数都必须有文档字符串：属于公共 API、规模不小，或逻辑并不显而易见。

文档字符串必须提供足够信息，使读者不必阅读函数代码就能写出调用。必须描述调用语法和语义。与使用有关的实现细节（例如把修改某个参数作为副作用）必须写入文档字符串。与调用方无关的实现细节必须写成代码旁边的注释，禁止写入文档字符串。

同一文件内的文档字符串必须统一为描述式或祈使式之一。`@property` 数据描述符的文档字符串必须与属性使用同一风格，禁止写成“返回……”。

下列小节以冒号结尾的标题行开始。除标题以外的所有内容必须保持 4 个空格的悬挂缩进。函数的名字和签名已经足够说明时，必须用一行文档字符串，并省略这些小节。

- `Args:` 按名字列出每个参数。说明跟在名字后面，用冒号分隔，冒号后是空格或换行。说明在[显示列宽上限](../coding-standard.md#11-显示列宽的统一计算)内放不进一行时，必须使用比参数名多 4 个空格的悬挂缩进。说明必须使用中文。代码里没有对应类型注解时，说明必须包含所需类型。`*foo` 和 `**bar` 必须按这个名字列出。
- `Returns:`（生成器则必须用 `Yields:`）描述返回值的语义，包括类型注解没有提供的类型信息。函数只返回 `None` 时不需要这一节。文档字符串以 “Return”、“Returns”、“Yield” 或 “Yields” 开头且开头一句足以描述返回值时，允许省略。禁止使用旧的 NumPy 风格把元组返回值写成多个各自有名字的返回值。必须描述为元组。辅助名字不必对应函数体里的内部名字。生成器的 `Yields:` 必须记录 `next()` 返回的对象，而不是生成器对象本身。
- `Raises:` 列出与接口相关的全部异常，并附上说明。格式与 `Args:` 相同。禁止记录只在违反文档字符串所规定的 API 时才会抛出的异常。

```
def fetch_smalltable_rows(
    table_handle: smalltable.Table,
    keys: Sequence[bytes | str],
    require_all_keys: bool = False,
) -> Mapping[bytes, tuple[str, ...]]:
    """按调用方给出的键从 Smalltable 读取行，字符串键会先按 UTF-8 编码。

    table_handle 必须是已经打开的表。缺行时是否失败由 require_all_keys 决定。

    Args:
        table_handle: 已经打开的 smalltable.Table，函数不会替调用方建连。
        keys: 要读取的键。字符串会先编码成 UTF-8，再向表查询。
        require_all_keys: 为真时，只要有一个键没有值就整批不返回。
    Returns:
        键到行的映射。每一行是字符串元组，返回的键始终是 bytes。
        某个键不在字典里，表示该行不存在，且 require_all_keys 当时为假。
    Raises:
        IOError: 访问 Smalltable 时发生了输入输出错误。
    """
```

```
def fetch_smalltable_rows(
    table_handle: smalltable.Table,
    keys: Sequence[bytes | str],
    require_all_keys: bool = False,
) -> Mapping[bytes, tuple[str, ...]]:
    """按调用方给出的键从 Smalltable 读取行，字符串键会先按 UTF-8 编码。

    参数名单独成行时，说明从下一行开始，并再悬挂缩进四个空格。

    Args:
        table_handle:
            已经打开的 smalltable.Table，函数不会替调用方建连。
        keys:
            要读取的键。字符串会先编码成 UTF-8，再向表查询。
        require_all_keys:
            为真时，只要有一个键没有值就整批不返回。
    Returns:
        键到行的映射。每一行是字符串元组，返回的键始终是 bytes。
        某个键不在字典里，表示该行不存在，且 require_all_keys 当时为假。
    Raises:
        IOError: 访问 Smalltable 时发生了输入输出错误。
    """
```


被装饰函数的文档字符串必须说明装饰器作用之后的函数行为。

```
@contextlib.contextmanager
def read_from_remote_filesystem(url: str) -> Iterator[RemoteFile]:
    """打开远程文件供读取，退出 with 时由上下文管理器关闭该文件，调用方不必再手动关。

    装饰器改变了调用方看到的行为，文档必须描述装饰之后的结果。

    Args:
        url: 远程文件的地址，调用方要保证它在打开期间有效。
    Returns:
        上下文管理器，进入 with 后得到远程文件的读取句柄。
    """
    reader = remote_file_reader(url)
    try:
        yield reader
    finally:
        reader.close()
```


##### 3.8.3.1 被覆盖的方法

覆盖基类方法的方法如果标了 `@override`，不需要文档字符串，除非覆盖方法的行为实质收紧了基类契约，或需要提供细节（例如额外副作用）。那时必须有至少说明这些差异的文档字符串。没有 `@override` 时必须自己写文档字符串。禁止只写“见父类”。

```
from typing import override

class Parent:
    def do_something(self):
        """父类方法的契约写在这里。子类若只是原样继承，就不必再抄一遍同一段说明文字，本例就是这样。
        """

# 子类方法标了 override，行为没有收紧父类契约，因此不再重复父类的文档字符串。
class Child(Parent):
    @override
    def do_something(self):
        pass
```


#### 3.8.4 类

类定义下方必须有描述该类的文档字符串。除属性以外的公共属性必须记录在 `Attributes` 一节，格式与函数的 `Args` 相同。

```
class SampleClass:
    """这个实例记录一份早餐偏好，以及按该偏好累计下来的鸡蛋数量，供后面的方法读取，本例就是这样。

    公共属性写在 Attributes 里，属性访问器不要重复列在这里。

    Attributes:
        likes_spam: 为真表示这个实例接受 SPAM，为假表示不接受。
        eggs: 已经累计的鸡蛋个数，从零开始，由实例自己更新。
    """

    def __init__(self, likes_spam: bool = False):
        """按调用方给出的 SPAM 偏好初始化实例，并把鸡蛋计数设为零，偏好只在这里写入一次。

        Args:
            likes_spam: 为真时实例接受 SPAM，默认不接受。
        """
        self.likes_spam = likes_spam
        self.eggs = 0

    @property
    def butter_sticks(self) -> int:
        """当前还剩多少根黄油。这个数量由实例状态算出来，不是构造函数传入的另一个动作，本例就是这样。
        """
```


类文档字符串必须以一行摘要开始，说明类实例代表什么。`Exception` 的子类必须描述该异常代表什么，禁止描述它可能在何种上下文中出现。禁止重复不必要的信息，例如这个类是一个类。

```
# 正例把对象含义或具体类型参数写出来，读者不用从类名或 Any 里猜测调用方得到什么。
class CheeseShopAddress:
    """这是一家奶酪店的地址，调用方用它定位店铺，而不是用它描述地址这个类本身，本例就是这样。
    """

class OutOfCheeseError(Exception):
    """表示奶酪已经没有库存。异常对象携带的是这种耗尽状态，而不是抛出它的那一层调用，本例就是这样。
    """
```


类被装饰时，文档字符串必须说明装饰器作用之后的类行为。

#### 3.8.5 块注释与行内注释

复杂操作必须在操作开始前用几行注释。不明显的地方必须在行尾写注释。这些注释必须离代码至少 2 个空格，以 `#` 开始，然后在注释文字之前至少再留一个空格。禁止复述代码。

```
# 用加权字典估计 i 在数组中的位置：先按最大值和长度外推，再二分找到精确下标，本例就是这样。

if i & (i-1) == 0:  # 当 i 为 0 或 2 的幂时这个位运算为真，只看运算符看不出这是在判断 2 的幂。
```


#### 3.8.6 标点、拼写与语法

注释必须注意标点、拼写和语法，必须使用恰当的大小写和标点。必须写成完整句子。行尾短注释允许不那么正式，但风格必须保持一致。

### 3.10 字符串

必须使用 f-string、`%` 运算符或 `format` 方法格式化字符串。单次用 `+` 连接允许。禁止用 `+` 做格式化。

```
x = f'name: {name}; score: {n}'
x = '%s, %s!' % (imperative, expletive)
x = '{}, {}'.format(first, second)
x = 'name: %s; score: %d' % (name, n)
x = 'name: %(name)s; score: %(score)d' % {'name':name, 'score':n}
x = 'name: {}; score: {}'.format(name, n)
x = a + b
```


禁止在循环里用 `+` 和 `+=` 累积字符串。必须把每个子串加入列表，循环结束后对列表做 `''.join`，或把每个子串写入 `io.StringIO`。

```
items = ['<table>']
for last_name, first_name in employee_list:
    items.append('<tr><td>%s, %s</td></tr>' % (last_name, first_name))
items.append('</table>')
employee_table = ''.join(items)
```


一个文件内的字符串引号必须一致，选定 `'` 或 `"` 后必须坚持。为避免反斜杠转义字符串内部的引号，允许在某个字符串上使用另一种引号。

```
Python('Why are you hiding your eyes?')
Gollum("I'm scared of lint errors.")
Narrator('"Good!" thought a happy Python reviewer.')
```


多行字符串必须使用 `"""`，禁止 `'''`。例外：普通字符串使用 `'` 时，项目允许对所有非文档字符串的多行字符串使用 `'''`。文档字符串无论如何都必须使用 `"""`。

多行字符串不得把额外空格嵌进字符串。不能接受前导空格时，必须使用拼接的单行字符串，或使用带 `textwrap.dedent()` 的多行字符串。字符串字面量内部的反斜杠换行是转义，不违反禁止显式续行的规定。

```
long_string = """This is fine if your use case can accept
  extraneous leading spaces."""
```

```
long_string = ("And this is fine if you cannot accept\n" +
                              "extraneous leading spaces.")
```

```
long_string = ("And this too is fine if you cannot accept\n"
                              "extraneous leading spaces.")
```

```
import textwrap

long_string = textwrap.dedent("""\
  This is also fine, because textwrap.dedent()
  will collapse common leading spaces in each line.""")
```


#### 3.10.1 日志

把带 `%-` 占位符的模式字符串作为第一个参数的日志函数，第一个参数必须是字符串字面量，禁止 f-string。模式参数必须作为后续参数传入。禁止把已经渲染好的消息当作唯一参数。

```
import tensorflow as tf
logger = tf.get_logger()
logger.info('TensorFlow Version is: %s', tf.__version__)
```

```
import os
from absl import logging

logging.info('Current $PAGER is: %s', os.getenv('PAGER', default=''))

homedir = os.getenv('HOME')
if homedir is None or not os.access(homedir, os.W_OK):
    logging.error('Cannot write to home directory, $HOME=%r', homedir)
```


#### 3.10.2 错误消息

错误消息（异常上的消息字符串，或展示给用户的消息）必须遵守：

1. 消息必须精确匹配实际的错误条件。
2. 插值片段必须始终能被清楚地认出是插值。
3. 消息必须允许简单的自动处理（例如用 grep 检索）。

```
if not 0 <= p <= 1:
    raise ValueError(f'Not a probability: {p=}')

try:
    os.rmdir(workdir)
except OSError as error:
    logging.warning('Could not remove directory (reason: %r): %r',
                                    error, workdir)
```


### 3.11 文件、套接字及类似的有状态资源

用完文件、套接字，以及内部使用套接字或以类似方式关闭的资源（数据库连接、mmap 映射、h5py 的 `File`、matplotlib.pyplot 的图形窗口等）后，必须明确关闭。禁止依赖 `__del__` 或终结器做具有可观察副作用的清理。

必须使用 `with` 语句。对不支持 `with` 的类文件对象，必须使用 `contextlib.closing()`。基于上下文的资源管理不可行时，代码文档必须清楚说明资源生存期如何管理。

```
import contextlib

with contextlib.closing(urllib.request.urlopen("http://www.python.org/")) as front_page:
    for line in front_page:
        print(line)
```


```
with open("hello.txt") as hello_file:
    for line in hello_file:
        print(line)
```


### 3.12 TODO 注释

临时的、短期的，或够用但并不完美的代码，必须使用 `TODO` 注释。

`TODO` 必须以全大写单词 `TODO` 开始，括号里放一个包含上下文的资源链接，并且必须是缺陷引用。上下文之后必须跟一个冒号和说明字符串。

```
# TODO(example.com/12345): 调查这条路径上的 cpufreq 调节是否真能降低功耗，结论出来前不要把实验代码留在热路径。
```

禁止把链接放在 `TODO:` 后面而不放进括号。禁止把个人或团队当作上下文。属于“在将来某个日期做某事”时，必须包含非常具体的日期，或未来维护者能理解的非常具体的事件，并且必须用问题单跟踪。

### 3.13 导入的格式

导入必须各占一行。`typing` 和 `collections.abc` 的导入允许一行导入多个符号。

导入必须放在文件顶部，紧接在模块注释和文档字符串之后、模块全局变量和常量之前。必须按从最通用到最不通用分组：

1. Python future 导入。
2. Python 标准库导入。
3. 第三方模块或包导入。
4. 代码仓库子包导入。
5. 与本文件属于同一个顶层子包的应用程序专用导入已废弃。新代码禁止单独分组，必须与其他子包导入同样对待。

每个分组内必须按每个模块的完整包路径忽略大小写做字典序排序。各分组之间允许空一行。禁止把同包导入留在函数里。

```
from collections.abc import Mapping, Sequence
import os
import sys
from typing import Any, NewType
```

```
from __future__ import annotations
```

```
import sys
```

```
import tensorflow as tf
```

```
from otherproject.ai import mind
```

```
import collections
import queue
import sys

from absl import app
from absl import flags
import bs4
import cryptography
import tensorflow as tf

from book.genres import scifi
from myproject.backend import huxley
from myproject.backend.hgwells import time_machine
from myproject.backend.state_machine import main_loop
from otherproject.ai import body
from otherproject.ai import mind
from otherproject.ai import soul
```


### 3.14 语句

一般每行只有一条语句。只有当整条语句能放在一行时，才允许把测试和测试结果放在同一行。`try`/`except` 禁止这样做。只有在没有 `else` 时，`if` 才允许这样做。

```
if foo: bar(foo)
```


### 3.15 读取器与设置器

读取器和设置器只在获取或设置变量提供有意义的角色或行为时允许使用，包括获取或设置很复杂或代价很大（无论是现在还是在合理的将来）。只是读写一个内部属性时，必须把该属性公开。设置变量意味着状态失效或需要重建时，必须使用设置器函数。只需简单逻辑时必须使用属性，或重构到不再需要读取器和设置器。

读取器和设置器必须命名为 `get_foo()` 和 `set_foo()`。过去允许通过属性访问时，禁止把新的读取器或设置器绑定到该属性上。仍用旧方式访问的代码必须明显失败。

### 3.16 命名

名字必须具有描述性。这包括函数、类、变量、属性、文件以及任何其他具名实体。禁止缩写。禁止使用对项目外读者含糊或陌生的缩写，也禁止删掉单词内部的字母来缩写。

文件必须使用 `.py` 扩展名。禁止连字符。

#### 3.16.1 禁止的名字

禁止单字符名字。例外：

- 计数器或迭代器（例如 `i`、`j`、`k`、`v`）
- `try`/`except` 中作为异常标识的 `e`
- `with` 语句中作为文件句柄的 `f`
- 没有约束的私有类型变量（例如 `_T = TypeVar("_T")`、`_P = ParamSpec("_P")`）
- 与参考文献或算法中既定记法一致的名字

描述性必须与名字可见范围成比例。禁止在多层嵌套作用域里滥用单字符名字。

同时禁止：包名或模块名中的连字符（`-`）；`__double_leading_and_trailing_underscore__` 这种由 Python 保留的名字；冒犯性词语；不必要地包含变量类型的名字（例如 `id_to_name_dict`）。

#### 3.16.2 命名约定

必须遵循 PEP 8 的命名约定。“内部”指模块内部，或类中受保护或私有。

前置单个下划线（`_`）表示受保护的模块变量和函数。单元测试访问被测模块的受保护常量允许。

禁止给实例变量或方法前置双下划线。必须使用单个下划线。

相关的类和顶层函数必须放在同一个模块里。禁止把自己限制为每个模块一个类。

类名必须使用 CapWords。模块名必须使用 `lower_with_under.py`。禁止新的 `CapWords.py` 模块名。

CapWords 中的首字母缩写必须全部大写，因此 `HTTPServerError`，禁止 `HttpServerError`。

新的单元测试方法名必须符合 PEP 8 的 `lower_with_under`，例如 `test_<method_under_test>_`。为与旧模块的 CapWords 函数名保持一致，以 `test` 开头的方法名中允许出现下划线来分隔逻辑成分。一种规定模式是 `test _ `。

当 Python 代码与外部或非 Python 代码库紧密耦合时（例如到 C++ 的 FFI），允许为了与另一代码库一致而遵循不同的命名约定。

#### 3.16.3 文件命名

Python 文件名必须有 `.py` 扩展名，并且不得包含连字符（`-`）。希望可执行文件不带扩展名也能访问时，必须使用符号链接，或一个包含 `exec "$0.py" "$@"` 的简单 bash 包装。

#### 3.16.4 命名表

| 类型 | 公开 | 内部 |
| --- | --- | --- |
| 包 | `lower_with_under` | |
| 模块 | `lower_with_under` | `_lower_with_under` |
| 类 | `CapWords` | `_CapWords` |
| 异常 | `CapWords` | |
| 函数 | `lower_with_under()` | `_lower_with_under()` |
| 全局/类常量 | `CAPS_WITH_UNDER` | `_CAPS_WITH_UNDER` |
| 全局/类变量 | `lower_with_under` | `_lower_with_under` |
| 实例变量 | `lower_with_under` | `_lower_with_under`（受保护） |
| 方法名 | `lower_with_under()` | `_lower_with_under()`（受保护） |
| 函数/方法参数 | `lower_with_under` | |
| 局部变量 | `lower_with_under` | |

#### 3.16.5 数学记法

数学含量很高的代码，如果短变量名与参考文献或算法中的既定记法一致，必须使用该记法，即使它们否则会违反风格指南。

使用基于既定记法的名字时：

1. 必须在注释或文档字符串里引用所有命名约定的来源，并且必须用超链接指向学术资料。来源无法访问时，必须清楚记录这些命名约定。
2. 公共 API 必须使用符合 PEP 8 的 `descriptive_names`。
3. 必须使用范围很窄的 `pylint: disable=invalid-name`。只有几个变量时，指令必须作为每一处的行尾注释；更多时，必须在块的开头应用该指令。

### 3.17 主函数

`pydoc` 与单元测试要求模块可以被导入。文件打算作为可执行文件使用时，主要功能必须放在 `main()` 里，并且执行主程序之前必须检查 `if __name__ == '__main__'`。

使用 absl 时必须使用 `app.run`。否则必须在该检查里调用 `main()`。

```
def main():
    ...

if __name__ == '__main__':
    main()
```


```
from absl import app
...

def main(argv: Sequence[str]):
    # 这里只处理旗标之外的位置参数，旗标解析要留在框架里，不要在 main 里再扫一遍 argv。
    ...

if __name__ == '__main__':
    app.run(main)
```


顶层代码会在模块被导入时执行。禁止在导入时调用函数、创建对象，或执行在文件被 `pydoc` 时不应当执行的其他操作。

### 3.18 函数长度

必须使用小而专注的函数。函数长度没有硬性上限。函数超过大约 40 行时必须拆开，除非拆开会损害程序结构。又长又复杂、难以调试，或其中一段需要在多个上下文使用时，必须拆成更小的函数。

### 3.19 类型注解

#### 3.19.1 一般规则

- 不要求给 `self` 或 `cls` 加注解。正确的类型信息需要时必须使用 `Self`。
- 不要求给 `__init__` 的返回值加注解。
- 任何其他变量或返回类型不应当被表达时，必须使用 `Any`。
- 不要求给模块里的所有函数加注解。
- 必须给公共 API 加注解。
- 容易出现类型相关错误的代码、难以理解的代码，以及从类型角度看已经稳定的代码，必须加注解。

```
from typing import Self

class BaseClass:
    @classmethod
    def create(cls) -> Self:
        ...

    def difference(self, other: Self) -> float:
        ...
```


#### 3.19.2 断行

必须遵循现有缩进规则。加注解后函数签名变成每个参数一行时，返回类型必须独占一行；必须在最后一个参数后面放一个逗号。所有内容都能放在同一行时必须放在同一行。

```
def my_method(self, first_var: int) -> int:
    ...
```


```
def my_method(
        self,
        first_var: int,
        second_var: Foo,
        third_var: Bar | None,
) -> int:
    ...
```


必须在变量之间断开，禁止在变量名和类型注解之间断开。函数名、最后一个参数和返回类型合在一起太长时，必须在新行上缩进 4 个空格。使用断行时，每个参数和返回类型必须各自放在一行，闭括号必须与 `def` 对齐。返回类型允许和最后一个参数放在同一行。禁止把闭括号移到新行并与开括号对齐。

```
def my_method(
        self,
        first_var: int,
        second_var: int) -> dict[OtherLongType, MyLongType]:
    ...
```


```
def my_method(
        self,
        other_arg: MyLongType | None,
) -> tuple[MyLongType1, MyLongType1]:
    ...
```


禁止把类型从中间断开。必须尽量保持子类型不断开。单个名字和类型太长时，必须为该类型使用别名。最后的办法是在冒号后断开并缩进 4 个空格。禁止在点号后面把类型名拆到下一行。

```
def my_function(
        long_variable_name:
                long_module_name.LongTypeName,
) -> None:
    ...
```


```
def my_method(
        self,
        first_var: tuple[list[MyLongType1],
                                          list[MyLongType2]],
        second_var: list[dict[
                MyLongType3, MyLongType4]],
) -> None:
    ...
```


#### 3.19.3 前向声明

使用同一模块中尚未定义的类名时，必须使用 `from __future__ import annotations`，或用字符串表示类名。

```
from __future__ import annotations

class MyClass:
    def __init__(self, stack: Sequence[MyClass], item: OtherClass) -> None:

class OtherClass:
    ...
```

```
class MyClass:
    def __init__(self, stack: Sequence['MyClass'], item: 'OtherClass') -> None:

class OtherClass:
    ...
```


#### 3.19.4 默认值

依据 PEP 8，只有对同时具有类型注解和默认值的参数，才必须在 `=` 周围使用空格。

```
def func(a: int = 0) -> int:
    ...
```


#### 3.19.5 NoneType

如果参数可以是 `None`，就必须声明。Python 3.12 代码必须使用 `|` 联合类型表达式。较旧的 `Optional` 和 `Union` 语法仍然允许。

必须使用显式的 `X | None`。禁止把 `a: str = None` 当作 `a: str | None = None`。禁止 `Union[None, str]` 这种把 `None` 放在前面的写法。

```
def modern_or_union(a: str | int | None, b: str | None = None) -> str:
    ...
def union_optional(a: Union[str, int, None], b: Optional[str] = None) -> str:
    ...
```


#### 3.19.6 类型别名

允许声明复杂类型的别名。别名的名字必须使用 CapWord。别名只在本模块使用时，必须是 `_Private`。别名必须注解为 `typing.TypeAlias`。禁止用类型别名代替不允许使用的 `from module import symbol`。模块内部的短别名允许用来减少行宽，但公共函数的签名里禁止出现调用方看不到定义的别名。

```
from typing import TypeAlias

_LossAndGradient: TypeAlias = tuple[tf.Tensor, tf.Tensor]
ComplexTFMap: TypeAlias = Mapping[str, _LossAndGradient]
```

```
# 模块内部可以用短别名减少行宽，但公共函数的签名里不要出现这个别名，调用方看不到它的定义。
_ShortName: TypeAlias = other_module.SignificantlyInconvenientlyLongName
```


#### 3.19.7 忽略类型

允许用 `# type: ignore` 关闭一行上的类型检查。`pyrefly` 的针对特定错误的关闭必须写成 `# pyrefly: ignore[错误名]`。禁止用整段函数的检查关闭代替单行抑制。

```
# 这一行的属性访问是类型检查器的误报，只抑制 attribute-error，不要把整段函数的检查都关掉。
# pyrefly: ignore[attribute-error]
```


#### 3.19.8 给变量标注类型

内部变量的类型很难或不可能推断时，必须用带注解的赋值标明类型：变量名和值之间使用冒号和类型。

```
a: Foo = SomeUndecoratedFunction()
```


代码库里可能仍留有行尾的 `# type: ` 注释，但 Python 3.12 代码禁止再新增这种旧式写法。

#### 3.19.9 元组与列表

带类型的列表只能包含单一类型的对象。带类型的元组既可以有单一重复类型（`tuple[int, ...]`），也可以有固定数量、类型各不相同的元素。

```
a: list[int] = [1, 2, 3]
b: tuple[int, ...] = (1, 2, 3)
c: tuple[int, str, float] = (1, "2", 3.5)
```


#### 3.19.10 类型变量

泛型必须使用 `TypeVar` 和 `ParamSpec` 这类类型变量。`TypeVar` 允许被约束。多个注解可以是 `bytes` 或 `str`、并且必须全部是同一类型时，必须使用 `AnyStr`。

```
from typing import AnyStr
def check_length(x: AnyStr) -> AnyStr:
    if len(x) <= 42:
        return x
    raise ValueError()
```


```
AddableType = TypeVar("AddableType", int, float, str)
def add(a: AddableType, b: AddableType) -> AddableType:
    return a + b
```


```
from collections.abc import Callable
from typing import ParamSpec, TypeVar
_P = ParamSpec("_P")
_T = TypeVar("_T")
...
def next(l: list[_T]) -> _T:
    return l.pop()

def print_when_called(f: Callable[_P, _T]) -> Callable[_P, _T]:
    def inner(*args: _P.args, **kwargs: _P.kwargs) -> _T:
        print("Function was called")
        return f(*args, **kwargs)
    return inner
```


类型变量必须有描述性的名字，除非同时满足：外部不可见，且没有被约束。满足这两条时必须使用 `_T`、`_P` 这类短名字。有约束或有上界的类型变量禁止使用这种短名字，也禁止省略前导下划线。

```
_T = TypeVar("_T")
_P = ParamSpec("_P")
AddableType = TypeVar("AddableType", int, float, str)
AnyFunction = TypeVar("AnyFunction", bound=Callable)
```


#### 3.19.11 字符串类型

禁止在新代码中使用 `typing.Text`。字符串或文本数据必须使用 `str`。二进制数据必须使用 `bytes`。函数的所有字符串类型始终相同时必须使用 `AnyStr`。

```
def deals_with_text_data(x: str) -> str:
    ...
def deals_with_binary_data(x: bytes) -> bytes:
    ...
```


#### 3.19.12 为类型标注而导入

对来自 `typing` 或 `collections.abc`、用于支持静态分析和类型检查的符号，必须导入符号本身。允许从这两个模块在一行上导入多个具体符号。这些名字必须类似关键字对待，禁止在代码里定义它们。与已有名字冲突时必须使用 `import x as y`。

```
from typing import Any as AnyType
```


```
from collections.abc import Mapping, Sequence
from typing import Any, Generic, cast, TYPE_CHECKING
```


函数签名必须使用 `collections.abc.Sequence` 这类抽象容器类型，禁止用 `list` 这类具体类型，除非确实需要具体类型。需要具体类型时必须使用 `tuple` 这类内置类型，禁止 `typing.Tuple`、`typing.List` 这类参数化类型别名。

```
from collections.abc import Sequence

def transform_coordinates(original: Sequence[tuple[float, float]]) ->
        Sequence[tuple[float, float]]:
    ...
```


#### 3.19.13 条件导入

必须重构代码以允许顶层导入。只有类型检查所需、且必须在运行时避免的额外导入，才允许条件导入。这类导入必须放在 `if TYPE_CHECKING:` 块里，并且：

- 条件导入的类型在 Python 3.12 下必须以字符串引用，因为注解表达式在运行时会被求值。
- 这里只允许定义仅用于类型标注的实体，包括别名。
- 该块必须紧接在所有普通导入之后。
- 类型导入列表中禁止空行。
- 必须把这个列表当作普通导入列表来排序。

```
import typing
if typing.TYPE_CHECKING:
    import sketch
def f(x: "sketch.Sketch"): ...
```


#### 3.19.14 循环依赖

由类型标注引起的循环依赖必须重构掉。必须用 `Any` 替换造成循环依赖导入的模块，用有意义的名字设置别名，并使用本模块中的真实类型名。别名定义必须与最后一条导入空开一行。使用处必须以字符串注解引用该类型。

```
from typing import Any

some_mod = Any  # some_mod.py 会导入本模块，这里用字符串注解避开两个模块在导入时互相等待。
...

def my_method(self, var: "some_mod.SomeType") -> None:
    ...
```


#### 3.19.15 泛型

加注解时必须为泛型类型指定类型参数。禁止省略参数而让它们被假定为 `Any`。能用 `TypeVar` 表达元素类型时必须使用 `TypeVar`。只有没有更具体的参数时，才允许显式写出 `Any`。

```
# 正例把对象含义或具体类型参数写出来，读者不用从类名或 Any 里猜测调用方得到什么。
def get_names(employee_ids: Sequence[int]) -> Mapping[int, str]:
    ...
```

```
# 正例把对象含义或具体类型参数写出来，读者不用从类名或 Any 里猜测调用方得到什么。
_T = TypeVar('_T')
def get_names(employee_ids: Sequence[_T]) -> Mapping[_T, str]:
    """按给定的员工编号返回编号到姓名的映射，编号的具体类型由调用方传入的序列决定，本例就是这样。
    """
```


## 4 结束语

修改代码时必须先看周围代码并采用它的局部风格，只要该风格不违反本指南。局部风格以及本指南未规定的选择必须保持一致。禁止用一致性作理由继续使用旧风格，而拒绝本指南的新规则。
