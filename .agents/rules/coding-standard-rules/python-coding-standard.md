# Google Python Style Guide

VeriQ adaptations below are normative and override the Google wording where they differ.

- Indent code blocks with 4 spaces. Never use a tab. Docstring hanging indents are 4 spaces. A sample that still shows a 2-space hanging indent is a negative example only.
- A code line is at most 120 characters, apart from the exceptions in the line-length section.
- Comments, including docstrings and inline notes, are written in Chinese. The product name VeriQ and technical identifiers may stay as written.
- The first line of a comment block contains at least 40 characters of comment text. Say what this code is doing; do not pad with a slogan.
- Each comment line is at most 80 characters. Wrap the rest. A machine directive (`pylint:`, `pyrefly:`, `# type:`) or an unsplittable URL may keep its own line when splitting it would change the syntax.



## 1 Background

Python is the main dynamic language used at Google. This style guide is a list of dos and don’ts for Python programs.

To help you format code correctly, we’ve created a settings file for Vim. For Emacs, the default settings should be fine.

Many teams use the Black or Pyink auto-formatter to avoid arguing over formatting.

## 2 Python Language Rules

### 2.1 Lint

Run `pylint` over your code using this pylintrc.

#### 2.1.1 Definition

`pylint` is a tool for finding bugs and style problems in Python source code. It finds problems that are typically caught by a compiler for less dynamic languages like C and C++. Because of the dynamic nature of Python, some warnings may be incorrect; however, spurious warnings should be fairly infrequent.

#### 2.1.2 Pros

Catches easy-to-miss errors like typos, using-vars-before-assignment, etc.

#### 2.1.3 Cons

`pylint` isn’t perfect. To take advantage of it, sometimes we’ll need to write around it, suppress its warnings or fix it.

#### 2.1.4 Decision

Make sure you run `pylint` on your code.

Suppress warnings if they are inappropriate so that other issues are not hidden. To suppress warnings, you can set a line-level comment:

```
# WSGI 要求方法名保持 do_PUT 这种协议拼写，因此只在这一行关掉 invalid-name，不把方法改成蛇形。
def do_PUT(self):  # pylint: disable=invalid-name
    ...

```

`pylint` warnings are each identified by symbolic name (`empty-docstring`) Google-specific warnings start with `g-`.

If the reason for the suppression is not clear from the symbolic name, add an explanation.

Suppressing in this way has the advantage that we can easily search for suppressions and revisit them.

You can get a list of `pylint` warnings by doing:

```
pylint --list-msgs

```

To get more information on a particular message, use:

```
pylint --help-msg=invalid-name

```

Prefer `pylint: disable` to the deprecated older form `pylint: disable-msg`.

Unused argument warnings can be suppressed by deleting the variables at the beginning of the function. Always include a Chinese comment explaining why you are deleting it. The first line of that comment block has at least 40 characters. “Unused.” is not sufficient. For example:

```
def viking_cafe_order(spam: str, beans: str, eggs: str | None = None) -> str:
    del beans, eggs  # 维京人这份订单不读取豆子和鸡蛋，删掉它们是为了标明参数未使用，而不是改成空字符串。
    return spam + spam + spam

```

Other common forms of suppressing this warning include using ‘`_`’ as the identifier for the unused argument or prefixing the argument name with ‘`unused_`’, or assigning them to ‘`_`’. These forms are allowed but no longer encouraged. These break callers that pass arguments by name and do not enforce that the arguments are actually unused.

### 2.2 Imports

Use `import` statements for packages and modules only, not for individual types, classes, or functions.

#### 2.2.1 Definition

Reusability mechanism for sharing code from one module to another.

#### 2.2.2 Pros

The namespace management convention is simple. The source of each identifier is indicated in a consistent way; `x.Obj` says that object `Obj` is defined in module `x`.

#### 2.2.3 Cons

Module names can still collide. Some module names are inconveniently long.

#### 2.2.4 Decision

- Use `import x` for importing packages and modules.
- Use `from x import y` where `x` is the package prefix and `y` is the module name with no prefix.
- Use `from x import y as z` in any of the following circumstances: 

- Two modules named `y` are to be imported.
- `y` conflicts with a top-level name defined in the current module.
- `y` conflicts with a common parameter name that is part of the public API (e.g., `features`).
- `y` is an inconveniently long name.
- `y` is too generic in the context of your code (e.g., `from storage.file_system import options as fs_options`).
- Use `import y as z` only when `z` is a standard abbreviation (e.g., `import numpy as np`).

For example the module `sound.effects.echo` may be imported as follows:

```
from sound.effects import echo
...
echo.EchoFilter(input, output, delay=0.7, atten=4)

```

Do not use relative names in imports. Even if the module is in the same package, use the full package name. This helps prevent unintentionally importing a package twice.

##### 2.2.4.1 Exemptions

Symbols from the following modules, used to support static analysis and type checking, are exempt from this rule:

- `typing` module
- `collections.abc` module
- `typing_extensions` module

### 2.3 Packages

Import each module using the full pathname location of the module.

#### 2.3.1 Pros

Avoids conflicts in module names or incorrect imports due to the module search path not being what the author expected. Makes it easier to find modules.

#### 2.3.2 Cons

Makes it harder to deploy code because you have to replicate the package hierarchy. Not really a problem with modern deployment mechanisms.

#### 2.3.3 Decision

All new code should import each module by its full package name.

Imports should be as follows:

```
Yes:
    # 这里用完整模块名 absl.flags 引用旗标，读者不用猜 flags 是从哪一个包导入的。
    import absl.flags
    from doctor.who import jodie

    _FOO = absl.flags.DEFINE_string(...)

```

```
Yes:
    # 从 absl 导入 flags 模块后，用模块名调用即可，不必每次写出 absl.flags 这个完整前缀。
    from absl import flags
    from doctor.who import jodie

    _FOO = flags.DEFINE_string(...)

```

(assume this file lives in `doctor/who/` where `jodie.py` also exists)

```
No:
    # 反例只写 import jodie，读者无法判断要的是同目录文件还是第三方包，实际导入还取决于 sys.path。
    import jodie

```

The directory the main binary is located in should not be assumed to be in `sys.path` despite that happening in some environments. This being the case, code should assume that `import jodie` refers to a third-party or top-level package named `jodie`, not a local `jodie.py`.

### 2.4 Exceptions

Exceptions are allowed but must be used carefully.

#### 2.4.1 Definition

Exceptions are a means of breaking out of normal control flow to handle errors or other exceptional conditions.

#### 2.4.2 Pros

The control flow of normal operation code is not cluttered by error-handling code. It also allows the control flow to skip multiple frames when a certain condition occurs, e.g., returning from N nested functions in one step instead of having to plumb error codes through.

#### 2.4.3 Cons

May cause the control flow to be confusing. Easy to miss error cases when making library calls.

#### 2.4.4 Decision

Exceptions must follow certain conditions:

- Make use of built-in exception classes when it makes sense. For example, raise a `ValueError` to indicate a programming mistake like a violated precondition, such as may happen when validating function arguments.
- Do not use `assert` statements in place of conditionals or validating preconditions. They must not be critical to the application logic. A litmus test would be that the `assert` could be removed without breaking the code. `assert` conditionals are not guaranteed to be evaluated. For pytest based tests, `assert` is okay and expected to verify expectations. For example:

```
Yes:
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

```
No:
    def connect_to_next_port(self, minimum: int) -> int:
        """从调用方传入的端口下限开始寻找，连上下一个可用端口之后，把新端口交还给调用方，本例就是这样。

        Args:
            minimum: 端口下限，必须大于或等于 1024。
        Returns:
            实际连上的新端口。反例没有列出失败时的异常。
        """
        assert minimum >= 1024, 'Minimum port must be at least 1024.'
        # 后面的查找直接使用 assert 留下的假设，assert 被关掉后这个前提就不再成立。
        port = self._find_next_open_port(minimum)
        assert port is not None
        # 返回语句的类型收窄依赖上一条 assert，检查器否则无法排除端口为 None。
        return port

```
- Libraries or packages may define their own exceptions. When doing so they must inherit from an existing exception class. Exception names should end in `Error` and should not introduce repetition (`foo.FooError`).
- Never use catch-all `except:` statements, or catch `Exception` or `StandardError`, unless you are

- re-raising the exception, or
- creating an isolation point in the program where exceptions are not propagated but are recorded and suppressed instead, such as protecting a thread from crashing by guarding its outermost block.

Python is very tolerant in this regard and `except:` will really catch everything including misspelled names, sys.exit() calls, Ctrl+C interrupts, unittest failures and all kinds of other exceptions that you simply don’t want to catch.
- Minimize the amount of code in a `try`/`except` block. The larger the body of the `try`, the more likely that an exception will be raised by a line of code that you didn’t expect to raise an exception. In those cases, the `try`/`except` block hides a real error.
- Use the `finally` clause to execute code whether or not an exception is raised in the `try` block. This is often useful for cleanup, i.e., closing a file.

### 2.5 Mutable Global State

Avoid mutable global state.

#### 2.5.1 Definition

Module-level values or class attributes that can get mutated during program execution.

#### 2.5.2 Pros

Occasionally useful.

#### 2.5.3 Cons

- Breaks encapsulation: Such design can make it hard to achieve valid objectives. For example, if global state is used to manage a database connection, then connecting to two different databases at the same time (such as for computing differences during a migration) becomes difficult. Similar problems easily arise with global registries.
- Has the potential to change module behavior during the import, because assignments to global variables are done when the module is first imported.

#### 2.5.4 Decision

Avoid mutable global state.

In those rare cases where using global state is warranted, mutable global entities should be declared at the module level or as a class attribute and made internal by prepending an `_` to the name. If necessary, external access to mutable global state must be done through public functions or class methods. See Naming below. Please explain the design reasons why mutable global state is being used in a comment or a doc linked to from a comment.

Module-level constants are permitted and encouraged. For example: `_MAX_HOLY_HANDGRENADE_COUNT = 3` for an internal use constant or `SIR_LANCELOTS_FAVORITE_COLOR = "blue"` for a public API constant. Constants must be named using all caps with underscores. See Naming below.

### 2.6 Nested/Local/Inner Classes and Functions

Nested local functions or classes are fine when used to close over a local variable. Inner classes are fine.

#### 2.6.1 Definition

A class can be defined inside of a method, function, or class. A function can be defined inside a method or function. Nested functions have read-only access to variables defined in enclosing scopes.

#### 2.6.2 Pros

Allows definition of utility classes and functions that are only used inside of a very limited scope. Very ADT-y. Commonly used for implementing decorators.

#### 2.6.3 Cons

Nested functions and classes cannot be directly tested. Nesting can make the outer function longer and less readable.

#### 2.6.4 Decision

They are fine with some caveats. Avoid nested functions or classes except when closing over a local value other than `self` or `cls`. Do not nest a function just to hide it from users of a module. Instead, prefix its name with an _ at the module level so that it can still be accessed by tests.

### 2.7 Comprehensions & Generator Expressions

Okay to use for simple cases.

#### 2.7.1 Definition

List, Dict, and Set comprehensions as well as generator expressions provide a concise and efficient way to create container types and iterators without resorting to the use of traditional loops, `map()`, `filter()`, or `lambda`.

#### 2.7.2 Pros

Simple comprehensions can be clearer and simpler than other dict, list, or set creation techniques. Generator expressions can be very efficient, since they avoid the creation of a list entirely.

#### 2.7.3 Cons

Complicated comprehensions or generator expressions can be hard to read.

#### 2.7.4 Decision

Comprehensions are allowed, however multiple `for` clauses or filter expressions are not permitted. Optimize for readability, not conciseness.

```
Yes:
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

```
No:
    result = [(x, y) for x in range(10) for y in range(5) if x * y > 10]

    return (
            (x, y, z)
            for x in range(5)
            for y in range(5)
            if x != y
            for z in range(5)
            if y != z
    )

```

### 2.8 Default Iterators and Operators

Use default iterators and operators for types that support them, like lists, dictionaries, and files.

#### 2.8.1 Definition

Container types, like dictionaries and lists, define default iterators and membership test operators (“in” and “not in”).

#### 2.8.2 Pros

The default iterators and operators are simple and efficient. They express the operation directly, without extra method calls. A function that uses default operators is generic. It can be used with any type that supports the operation.

#### 2.8.3 Cons

You can’t tell the type of objects by reading the method names (unless the variable has type annotations). This is also an advantage.

#### 2.8.4 Decision

Use default iterators and operators for types that support them, like lists, dictionaries, and files. The built-in types define iterator methods, too. Prefer these methods to methods that return lists, except that you should not mutate a container while iterating over it.

```
Yes:  for key in adict: ...
      if obj in alist: ...
      for line in afile: ...
      for k, v in adict.items(): ...

```

```
No:   for key in adict.keys(): ...
      for line in afile.readlines(): ...

```

### 2.9 Generators

Use generators as needed.

#### 2.9.1 Definition

A generator function returns an iterator that yields a value each time it executes a yield statement. After it yields a value, the runtime state of the generator function is suspended until the next value is needed.

#### 2.9.2 Pros

Simpler code, because the state of local variables and control flow are preserved for each call. A generator uses less memory than a function that creates an entire list of values at once.

#### 2.9.3 Cons

Local variables in the generator will not be garbage collected until the generator is either consumed to exhaustion or itself garbage collected.

#### 2.9.4 Decision

Fine. Use “Yields:” rather than “Returns:” in the docstring for generator functions.

If the generator manages an expensive resource, make sure to force the clean up.

A good way to do the clean up is by wrapping the generator with a context manager PEP-0533.

### 2.10 Lambda Functions

Okay for one-liners. Prefer generator expressions over `map()` or `filter()` with a `lambda`.

#### 2.10.1 Definition

Lambdas define anonymous functions in an expression, as opposed to a statement.

#### 2.10.2 Pros

Convenient.

#### 2.10.3 Cons

Harder to read and debug than local functions. The lack of names means stack traces are more difficult to understand. Expressiveness is limited because the function may only contain an expression.

#### 2.10.4 Decision

Lambdas are allowed. If the code inside the lambda function spans multiple lines or is longer than 60-80 chars, it might be better to define it as a regular nested function.

For common operations like multiplication, use the functions from the `operator` module instead of lambda functions. For example, prefer `operator.mul` to `lambda x, y: x * y`.

### 2.11 Conditional Expressions

Okay for simple cases.

#### 2.11.1 Definition

Conditional expressions (sometimes called a “ternary operator”) are mechanisms that provide a shorter syntax for if statements. For example: `x = 1 if cond else 2`.

#### 2.11.2 Pros

Shorter and more convenient than an if statement.

#### 2.11.3 Cons

May be harder to read than an if statement. The condition may be difficult to locate if the expression is long.

#### 2.11.4 Decision

Okay to use for simple cases. Each portion must fit on one line: true-expression, if-expression, else-expression. Use a complete if statement when things get more complicated.

```
Yes:
    one_line = 'yes' if predicate(value) else 'no'
    slightly_split = ('yes' if predicate(value)
                      else 'no, nein, nyet')
    the_longest_ternary_style_that_can_be_done = (
        'yes, true, affirmative, confirmed, correct'
        if predicate(value)
        else 'no, false, negative, nay')

```

```
No:
    bad_line_breaking = ('yes' if predicate(value) else
                         'no')
    portion_too_long = ('yes'
                        if some_long_module.some_long_predicate_function(
                            really_long_variable_name)
                        else 'no, false, negative, nay')

```

### 2.12 Default Argument Values

Okay in most cases.

#### 2.12.1 Definition

You can specify values for variables at the end of a function’s parameter list, e.g., `def foo(a, b=0):`. If `foo` is called with only one argument, `b` is set to 0. If it is called with two arguments, `b` has the value of the second argument.

#### 2.12.2 Pros

Often you have a function that uses lots of default values, but on rare occasions you want to override the defaults. Default argument values provide an easy way to do this, without having to define lots of functions for the rare exceptions. As Python does not support overloaded methods/functions, default arguments are an easy way of “faking” the overloading behavior.

#### 2.12.3 Cons

Default arguments are evaluated once at module load time. This may cause problems if the argument is a mutable object such as a list or a dictionary. If the function modifies the object (e.g., by appending an item to a list), the default value is modified.

#### 2.12.4 Decision

Okay to use with the following caveat:

Do not use mutable objects as default values in the function or method definition.

```
Yes: def foo(a, b=None):
         if b is None:
             b = []
Yes: def foo(a, b: Sequence | None = None):
         if b is None:
             b = []
# 空元组不可变，拿它当默认值不会在多次调用之间被改掉，调用方每次看到的都是同一个空元组。
Yes: def foo(a, b: Sequence = ()):
         ...

```

```
from absl import flags
_FOO = flags.DEFINE_string(...)

No:  def foo(a, b=[]):
         ...
No:  def foo(a, b=time.time()):  # 默认值在模块导入时就算好，b 会固定成导入那一刻，而不是函数每次被调用时的当前时间。
         ...
No:  def foo(a, b=_FOO.value):  # 函数定义时旗标还没有解析，把 _FOO.value 写进默认值会拿到解析前的空值。
         ...
# 把可变的空字典当作默认映射时，调用方可能把它继续传给不会复制实参的下游代码，本例就是这样。
No:  def foo(a, b: Mapping = {}):
         ...

```

### 2.13 Properties

Properties may be used to control getting or setting attributes that require trivial computations or logic. Property implementations must match the general expectations of regular attribute access: that they are cheap, straightforward, and unsurprising.

#### 2.13.1 Definition

A way to wrap method calls for getting and setting an attribute as a standard attribute access.

#### 2.13.2 Pros

- Allows for an attribute access and assignment API rather than getter and setter method calls.
- Can be used to make an attribute read-only.
- Allows calculations to be lazy.
- Provides a way to maintain the public interface of a class when the internals evolve independently of class users.

#### 2.13.3 Cons

- Can hide side-effects much like operator overloading.
- Can be confusing for subclasses.

#### 2.13.4 Decision

Properties are allowed, but, like operator overloading, should only be used when necessary and match the expectations of typical attribute access; follow the getters and setters rules otherwise.

For example, using a property to simply both get and set an internal attribute isn’t allowed: there is no computation occurring, so the property is unnecessary (make the attribute public instead). In comparison, using a property to control attribute access or to calculate a trivially derived value is allowed: the logic is simple and unsurprising.

Properties should be created with the `@property` decorator. Manually implementing a property descriptor is considered a power feature.

Inheritance with properties can be non-obvious. Do not use properties to implement computations a subclass may ever want to override and extend.

### 2.14 True/False Evaluations

Use the “implicit” false if at all possible (with a few caveats).

#### 2.14.1 Definition

Python evaluates certain values as `False` when in a boolean context. A quick “rule of thumb” is that all “empty” values are considered false, so `0, None, [], {}, ''` all evaluate as false in a boolean context.

#### 2.14.2 Pros

Conditions using Python booleans are easier to read and less error-prone. In most cases, they’re also faster.

#### 2.14.3 Cons

May look strange to C/C++ developers.

#### 2.14.4 Decision

Use the “implicit” false if possible, e.g., `if foo:` rather than `if foo != []:`. There are a few caveats that you should keep in mind though:

- Always use `if foo is None:` (or `is not None`) to check for a `None` value. E.g., when testing whether a variable or argument that defaults to `None` was set to some other value. The other value might be a value that’s false in a boolean context!
- Never compare a boolean variable to `False` using `==`. Use `if not x:` instead. If you need to distinguish `False` from `None` then chain the expressions, such as `if not x and x is not None:`.
- For sequences (strings, lists, tuples), use the fact that empty sequences are false, so `if seq:` and `if not seq:` are preferable to `if len(seq):` and `if not len(seq):` respectively.
- When handling integers, implicit false may involve more risk than benefit (i.e., accidentally handling `None` as 0). You may compare a value which is known to be an integer (and is not the result of `len()`) against the integer 0.

```
Yes: if not users:
         print('no users')

     if i % 10 == 0:
         self.handle_multiple_of_ten()

     def f(x=None):
         if x is None:
             x = []

```

```
No:  if len(users) == 0:
         print('no users')

     if not i % 10:
         self.handle_multiple_of_ten()

     def f(x=None):
         x = x or []

```
- Note that `'0'` (i.e., `0` as string) evaluates to true.
- Note that Numpy arrays may raise an exception in an implicit boolean context. Prefer the `.size` attribute when testing emptiness of a `np.array` (e.g. `if not users.size`).

### 2.16 Lexical Scoping

Okay to use.

#### 2.16.1 Definition

A nested Python function can refer to variables defined in enclosing functions, but cannot assign to them. Variable bindings are resolved using lexical scoping, that is, based on the static program text. Any assignment to a name in a block will cause Python to treat all references to that name as a local variable, even if the use precedes the assignment. If a global declaration occurs, the name is treated as a global variable.

An example of the use of this feature is:

```
def get_adder(summand1: float) -> Callable[[float], float]:
    """返回的闭包会把后来传入的数加到构造时给定的加数上，加数在闭包创建时就已经固定，本例就是这样。
    """
    def adder(summand2: float) -> float:
        return summand1 + summand2

    return adder

```

#### 2.16.2 Pros

Often results in clearer, more elegant code. Especially comforting to experienced Lisp and Scheme (and Haskell and ML and …) programmers.

#### 2.16.3 Cons

Can lead to confusing bugs, such as this example based on PEP-0227:

```
i = 4
def foo(x: Iterable[int]):
    def bar():
        print(i, end='')
    # 中间省略了若干语句，用来表明后面的 for 才把名字 i 绑成 foo 的局部变量。
    for i in x:  # 循环把 i 赋给了 foo 的局部变量，bar 读到的是这个局部绑定，而不是外层的 i。
        print(i, end='')
    bar()

```

So `foo([1, 2, 3])` will print `1 2 3 3`, not `1 2 3 4`.

#### 2.16.4 Decision

Okay to use.

### 2.17 Function and Method Decorators

Use decorators judiciously when there is a clear advantage. Avoid `staticmethod` and limit use of `classmethod`.

#### 2.17.1 Definition

Decorators for Functions and Methods (a.k.a “the `@` notation”). One common decorator is `@property`, used for converting ordinary methods into dynamically computed attributes. However, the decorator syntax allows for user-defined decorators as well. Specifically, for some function `my_decorator`, this:

```
class C:
    @my_decorator
    def method(self):
        # 方法体在此省略，这个示例只关心装饰器写在 def 的上方，而不是装饰之后再赋回。

```

is equivalent to:

```
class C:
    def method(self):
        # 方法体在此省略，这个示例只关心装饰器写在 def 的上方，而不是装饰之后再赋回。
    method = my_decorator(method)

```

#### 2.17.2 Pros

Elegantly specifies some transformation on a method; the transformation might eliminate some repetitive code, enforce invariants, etc.

#### 2.17.3 Cons

Decorators can perform arbitrary operations on a function’s arguments or return values, resulting in surprising implicit behavior. Additionally, decorators execute at object definition time. For module-level objects (classes, module functions, …) this happens at import time. Failures in decorator code are pretty much impossible to recover from.

#### 2.17.4 Decision

Use decorators judiciously when there is a clear advantage. Decorators should follow the same import and naming guidelines as functions. A decorator docstring should clearly state that the function is a decorator. Write unit tests for decorators.

Avoid external dependencies in the decorator itself (e.g. don’t rely on files, sockets, database connections, etc.), since they might not be available when the decorator runs (at import time, perhaps from `pydoc` or other tools). A decorator that is called with valid parameters should (as much as possible) be guaranteed to succeed in all cases.

Decorators are a special case of “top-level code” - see main for more discussion.

Never use `staticmethod` unless forced to in order to integrate with an API defined in an existing library. Write a module-level function instead.

Use `classmethod` only when writing a named constructor, or a class-specific routine that modifies necessary global state such as a process-wide cache.

### 2.18 Threading

Do not rely on the atomicity of built-in types.

While Python’s built-in data types such as dictionaries appear to have atomic operations, there are corner cases where they aren’t atomic (e.g. if `__hash__` or `__eq__` are implemented as Python methods) and their atomicity should not be relied upon. Neither should you rely on atomic variable assignment (since this in turn depends on dictionaries).

Use the `queue` module’s `Queue` data type as the preferred way to communicate data between threads. Otherwise, use the `threading` module and its locking primitives. Prefer condition variables and `threading.Condition` instead of using lower-level locks.

### 2.19 Power Features

Avoid these features.

#### 2.19.1 Definition

Python is an extremely flexible language and gives you many fancy features such as custom metaclasses, access to bytecode, on-the-fly compilation, dynamic inheritance, object reparenting, import hacks, reflection (e.g. some uses of `getattr()`), modification of system internals, `__del__` methods implementing customized cleanup, etc.

#### 2.19.2 Pros

These are powerful language features. They can make your code more compact.

#### 2.19.3 Cons

It’s very tempting to use these “cool” features when they’re not absolutely necessary. It’s harder to read, understand, and debug code that’s using unusual features underneath. It doesn’t seem that way at first (to the original author), but when revisiting the code, it tends to be more difficult than code that is longer but is straightforward.

#### 2.19.4 Decision

Avoid these features in your code.

Standard library modules and classes that internally use these features are okay to use (for example, `abc.ABCMeta`, `dataclasses`, and `enum`).

### 2.20 Modern Python: from __future__ imports

New language version semantic changes may be gated behind a special future import to enable them on a per-file basis within earlier runtimes.

#### 2.20.1 Definition

Being able to turn on some of the more modern features via `from __future__ import` statements allows early use of features from expected future Python versions.

#### 2.20.2 Pros

This has proven to make runtime version upgrades smoother as changes can be made on a per-file basis while declaring compatibility and preventing regressions within those files. Modern code is more maintainable as it is less likely to accumulate technical debt that will be problematic during future runtime upgrades.

#### 2.20.3 Cons

Such code may not work on very old interpreter versions prior to the introduction of the needed future statement. The need for this is more common in projects supporting an extremely wide variety of environments.

#### 2.20.4 Decision

##### from __future__ imports

Use of `from __future__ import` statements is encouraged. It allows a given source file to start using more modern Python syntax features today. Once you no longer need to run on a version where the features are hidden behind a `__future__` import, feel free to remove those lines.

In code that may execute on versions as old as 3.5 rather than >= 3.7, import:

```
from __future__ import generator_stop

```

For more information read the Python future statement definitions documentation.

Please don’t remove these imports until you are confident the code is only ever used in a sufficiently modern environment. Even if you do not currently use the feature a specific future import enables in your code today, keeping it in place in the file prevents later modifications of the code from inadvertently depending on the older behavior.

Use other `from __future__` import statements as you see fit.

### 2.21 Type Annotated Code

You can annotate Python code with type hints. Type-check the code at build time with a type checking tool like pyrefly. In most cases, when feasible, type annotations are in source files. For third-party or extension modules, annotations can be in stub `.pyi` files.

#### 2.21.1 Definition

Type annotations (or “type hints”) are for function or method arguments and return values:

```
def func(a: int) -> list[int]:

```

You can also declare the type of a variable using similar syntax:

```
a: SomeType = some_func()

```

#### 2.21.2 Pros

Type annotations improve the readability and maintainability of your code. The type checker will convert many runtime errors to build-time errors, and reduce your ability to use Power Features.

#### 2.21.3 Cons

You will have to keep the type declarations up to date. You might see type errors that you think are valid code. Use of a type checker may reduce your ability to use Power Features.

#### 2.21.4 Decision

You are strongly encouraged to enable Python type analysis when updating code. When adding or modifying public APIs, include type annotations and enable type-checking in the build system. As static analysis is relatively new to Python, we acknowledge that undesired side-effects (such as wrongly inferred types) may prevent adoption by some projects. In those situations, authors are encouraged to add a comment with a TODO or link to a bug describing the issue(s) currently preventing type annotation adoption in the BUILD file or in the code itself as appropriate.

## 3 Python Style Rules

### 3.1 Semicolons

Do not terminate your lines with semicolons, and do not use semicolons to put two statements on the same line.

### 3.2 Line length

Maximum code line length is 120 characters.

Comment lines are at most 80 characters; wrap comment prose past that. The first line of a comment block has at least 40 characters of Chinese comment text.

Explicit exceptions to the 120-character code-line limit:

- Long import statements.
- Long string module-level constants not containing whitespace that would be inconvenient to split across lines, such as URLs or pathnames.
- An unsplittable URL or a machine directive in a comment (`# pylint: disable=invalid-name`, `# pyrefly: ignore[...]`, `# type:`) may exceed 80 characters when breaking the line would change the syntax. The Chinese prose around that directive still wraps at 80.


Do not use a backslash for explicit line continuation.

Instead, make use of Python’s implicit line joining inside parentheses, brackets and braces. If necessary, you can add an extra pair of parentheses around an expression.

Note that this rule doesn’t prohibit backslash-escaped newlines within strings (see below).

```
Yes: foo_bar(self, width, height, color='black', design=None, x='foo',
             emphasis=None, highlight=0)

```

```

Yes: if (width == 0 and height == 0 and
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

```

No:  if width == 0 and height == 0 and \
         color == 'red' and emphasis == 'strong':

     bridge_questions.clarification_on \
         .average_airspeed_of.unladen_swallow = 'African or European?'

     with very_long_first_expression_function() as spam, \
           very_long_second_expression_function() as beans, \
           third_thing() as eggs:
       place_order(eggs, beans, spam, beans)

```

When a literal string won’t fit on a single line, use parentheses for implicit line joining.

```
x = ('This will build a very long long '
     'long long long long long long string')

```

Prefer to break lines at the highest possible syntactic level. If you must break a line twice, break it at the same syntactic level both times.

```
Yes: bridgekeeper.answer(
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
No: bridgekeeper.answer(name="Arthur", quest=questlib.find(
        owner="Arthur", perilous=True))

    answer = a_long_line().of_chained_methods().that_eventually_provides(
        ).an_answer()

    if (config is None or 'editor.language' not in config or config[
        'editor.language'].use_spaces is False):
      use_tabs()

```

Within comments, put long URLs on their own line if necessary.

```
Yes:  # 字段的完整说明放在下一行的链接里，链接本身不要从中间折断，否则读者无法直接打开。
      # 规范链接单独占一行，读者和工具都能整段复制，不用把被折断的路径再拼回去，本例就是这样。
      # http://www.example.com/us/developer/documentation/api/content/v2.0/csv_file_name_extension_full_specification.html

```

```
No:  # 字段的完整说明放在下一行的链接里，链接本身不要从中间折断，否则读者无法直接打开。
     # 反例用反斜杠把链接拆成两行，读者无法直接打开，长链接应整段留在同一行里，本例就是这样。
     # http://www.example.com/us/developer/documentation/api/content/\
     # v2.0/csv_file_name_extension_full_specification.html

```

Make note of the indentation of the elements in the line continuation examples above; see the indentation section for explanation.

The docstring summary is written in Chinese. That first line contains at least 40 characters and at most 80 characters.

In all other cases where a code line exceeds 120 characters, and the formatter does not bring the line under the limit, the line may exceed this maximum. Authors should still break the line by the rules above when that is sensible.

### 3.3 Parentheses

Use parentheses sparingly.

It is fine, though not required, to use parentheses around tuples. Do not use them in return statements or conditional statements unless using parentheses for implied line continuation or to indicate a tuple.

```
Yes: if foo:
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

```
No:  if (x):
         bar()
     if not(x):
         bar()
     return (foo)

```

### 3.4 Indentation

Indent your code blocks with 4 spaces.

Never use tabs. Implied line continuation should align wrapped elements vertically (see line length examples), or use a hanging 4-space indent. Closing (round, square or curly) brackets can be placed at the end of the expression, or on separate lines, but then should be indented the same as the line with the corresponding opening bracket.

```
Yes:  # 续行与开括号之后的第一个参数对齐，读者能看出这些参数属于同一次函数调用，本例就是这样。
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

```
No:  # 反例在第一行已经放了参数，续行却又改成悬挂缩进，两种对齐混在同一次调用里，本例就是这样。
       foo = long_function_name(var_one, var_two,
           var_three, var_four)
       meal = (spam,
           beans)

       # 反例只用两个空格做悬挂缩进，悬挂必须是四个空格，两格缩进不能出现在正例里，本例就是这样。
       foo = long_function_name(
         var_one, var_two, var_three,
         var_four)

       # 反例的字典值换行后没有再缩进，读者分不清这一行是值，还是下一个键，本例就是这样。
       foo = {
           'long_dictionary_key':
           long_dictionary_value,
           ...
       }

```

#### 3.4.1 Trailing commas in sequences of items?

Trailing commas in sequences of items are recommended only when the closing container token `]`, `)`, or `}` does not appear on the same line as the final element, as well as for tuples with a single element. The presence of a trailing comma is also used as a hint to our Python code auto-formatter Black or Pyink to direct it to auto-format the container of items to one item per line when the `,` after the final element is present.

```
Yes:   golomb3 = [0, 1, 3]
       golomb4 = [
           0,
           1,
           4,
           6,
       ]

```

```
No:    golomb4 = [
           0,
           1,
           4,
           6,]

```

### 3.5 Blank Lines

Two blank lines between top-level definitions, be they function or class definitions. One blank line between method definitions and between the docstring of a `class` and the first method. No blank line following a `def` line. Use single blank lines as you judge appropriate within functions or methods.

Blank lines need not be anchored to the definition. For example, related comments immediately preceding function, class, and method definitions can make sense. Consider if your comment might be more useful as part of the docstring.

### 3.6 Whitespace

Follow standard typographic rules for the use of spaces around punctuation.

No whitespace inside parentheses, brackets or braces.

```
Yes: spam(ham[1], {'eggs': 2}, [])

```

```
No:  spam( ham[ 1 ], { 'eggs': 2 }, [ ] )

```

No whitespace before a comma, semicolon, or colon. Do use whitespace after a comma, semicolon, or colon, except at the end of the line.

```
Yes: if x == 4:
         print(x, y)
     x, y = y, x

```

```
No:  if x == 4 :
         print(x , y)
     x , y = y , x

```

No whitespace before the open paren/bracket that starts an argument list, indexing or slicing.

```
Yes: spam(1)

```

```
No:  spam (1)

```

```
Yes: dict['key'] = list[index]

```

```
No:  dict ['key'] = list [index]

```

No trailing whitespace.

Surround binary operators with a single space on either side for assignment (`=`), comparisons (`==, <, >, !=, <>, <=, >=, in, not in, is, is not`), and Booleans (`and, or, not`). Use your better judgment for the insertion of spaces around arithmetic operators (`+`, `-`, `*`, `/`, `//`, `%`, `**`, `@`).

```
Yes: x == 1

```

```
No:  x<1

```

Never use spaces around `=` when passing keyword arguments or defining a default parameter value, with one exception: when a type annotation is present, do use spaces around the `=` for the default parameter value.

```
Yes: def complex(real, imag=0.0): return Magic(r=real, i=imag)
Yes: def complex(real, imag: float = 0.0): return Magic(r=real, i=imag)

```

```
No:  def complex(real, imag = 0.0): return Magic(r = real, i = imag)
No:  def complex(real, imag: float=0.0): return Magic(r = real, i = imag)

```

Don’t use spaces to vertically align tokens on consecutive lines, since it becomes a maintenance burden (applies to `:`, `#`, `=`, etc.):

```
Yes:
    foo = 1000  # 行尾注释说明这个赋值的含义，和代码之间只留两个空格，不要为了竖齐去垫空格，本例就是这样。
    long_name = 2  # 这条注释故意不和上一行的注释竖齐，竖齐会在改名时制造无关的空白差异，本例就是这样。

    dictionary = {
            'foo': 1,
            'long_name': 2,
    }

```

```
No:
    foo       = 1000  # 行尾注释说明这个赋值的含义，和代码之间只留两个空格，不要为了竖齐去垫空格，本例就是这样。
    long_name = 2  # 这条注释故意不和上一行的注释竖齐，竖齐会在改名时制造无关的空白差异，本例就是这样。

    dictionary = {
            'foo'      : 1,
            'long_name': 2,
    }

```

### 3.7 Shebang Line

Most `.py` files do not need to start with a `#!` line. Start the main file of a program with `#!/usr/bin/env python3` (to support virtualenvs) or `#!/usr/bin/python3` per PEP-394.

This line is used by the kernel to find the Python interpreter, but is ignored by Python when importing modules. It is only necessary on a file intended to be executed directly.

### 3.8 Comments and Docstrings

Be sure to use the right style for module, function, method docstrings and inline comments.

#### 3.8.1 Docstrings

Python uses docstrings to document code. A docstring is a string that is the first statement in a package, module, class or function. These strings can be extracted automatically through the `__doc__` member of the object and are used by `pydoc`. (Try running `pydoc` on your module to see how it looks.) Always use the three-double-quote `"""` format for docstrings (per PEP 257). A docstring summary is written in Chinese, as one physical line of at least 40 and at most 80 characters, and ends with `。`, `？`, or `！`. When writing more (encouraged), this must be followed by a blank line, followed by the rest of the docstring starting at the same cursor position as the first quote of the first line. There are more formatting guidelines for docstrings below.

#### 3.8.2 Modules

Every file should contain license boilerplate. Choose the appropriate boilerplate for the license used by the project (for example, Apache 2.0, BSD, LGPL, GPL).

Files should start with a docstring describing the contents and usage of the module.

```
"""用中文说明这个模块提供什么能力，以及调用方应该从哪里进入，不要只重复文件名，本例就是这样。

空一行之后再写整体行为。需要时补充导出的类、函数，并给出最短的调用示例。

    foo = ClassFoo()
    bar = foo.function_bar()
"""

```

##### 3.8.2.1 Test modules

Test modules do not require module level docstrings. Class docstrings are not required on subclasses of `unittest.TestCase` and method docstrings are not required on `test_` methods in subclasses of `unittest.TestCase`. A docstring that only repeats class or method name should be omitted.

Docstrings should be included when they provide additional information, for example, providing specifics on how the test should be run or explaining an unusual setup pattern or external dependency.

```
"""这个测试把黄金文件当作期望输出，失败时要对照那些文件，而不是只看断言文本，本例就是这样。

更新黄金文件需要显式带上 --update_golden_files，不要在普通运行里改写期望结果。
"""

```

Docstrings that do not provide any new information should not be used.

```
"""反例只重复了模块名 foo.bar，没有说明断言在保护哪一种行为，这种文档字符串应当删掉。
"""

```

or

```
    def test_foo_is_barred(self):
        """这个测试固定的是 bar 会作用到 foo 上，而不是只确认测试方法能被收集到。
        """

```

#### 3.8.3 Functions and Methods

In this section, “function” means a method, function, generator, or property.

A docstring is mandatory for every function that has one or more of the following properties:

- being part of the public API
- nontrivial size
- non-obvious logic

A docstring should give enough information to write a call to the function without reading the function’s code. The docstring should describe the function’s calling syntax and its semantics, but generally not its implementation details, unless those details are relevant to how the function is to be used. For example, a function that mutates one of its arguments as a side effect should note that in its docstring. Otherwise, subtle but important details of a function’s implementation that are not relevant to the caller are better expressed as comments alongside the code than within the function’s docstring.

The docstring may be descriptive-style (`"""按调用方给出的键从 Bigtable 读取对应的数据行，调用方不必关心底层如何分片。"""`) or imperative-style (`"""请按调用方给出的键从 Bigtable 读取对应数据行，不要把分片细节泄漏给调用方。"""`), but the style should be consistent within a file. The docstring for a `@property` data descriptor should use the same style as an attribute (`"""这是当前已经打开的 Bigtable 表路径，调用方只能拿它去拼接后续读写请求。"""`), not a returns-phrase.

Certain aspects of a function should be documented in special sections, listed below. Each section begins with a heading line, which ends with a colon. All sections other than the heading should maintain a hanging indent of four spaces. These sections can be omitted in cases where the function’s name and signature are informative enough that it can be aptly described using a one-line docstring.

Args:
: List each parameter by name. A description should follow the name, and be separated by a colon followed by either a space or newline. If the description is too long to fit on a single 80-character comment line, use a hanging indent of 4 spaces more than the parameter name. The description is written in Chinese. The description should include required type(s) if the code does not contain a corresponding type annotation. If a function accepts `*foo` (variable length argument lists) and/or `**bar` (arbitrary keyword arguments), they should be listed as `*foo` and `**bar`.
Returns: (or Yields: for generators)
: Describe the semantics of the return value, including any type information that the type annotation does not provide. If the function only returns None, this section is not required. It may also be omitted if the docstring starts with “Return”, “Returns”, “Yield”, or “Yields” (e.g. `"""Returns row from Bigtable as a tuple of strings."""`) and the opening sentence is sufficient to describe the return value. Do not imitate older ‘NumPy style’ (example), which frequently documented a tuple return value as if it were multiple return values with individual names (never mentioning the tuple). Instead, describe such a return value as: “Returns: A tuple (mat_a, mat_b), where mat_a is …, and …”. The auxiliary names in the docstring need not necessarily correspond to any internal names used in the function body (as those are not part of the API). If the function uses `yield` (is a generator), the `Yields:` section should document the object returned by `next()`, instead of the generator object itself that the call evaluates to.
Raises:
: List all exceptions that are relevant to the interface followed by a description. Use a similar exception name + colon + space or newline and hanging indent style as described in Args:. You should not document exceptions that get raised if the API specified in the docstring is violated (because this would paradoxically make behavior under violation of the API part of the API).

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

Similarly, this variation on `Args:` with a line break is also allowed:

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

A decorated function’s docstring must specify the function’s behavior after the decorator has been applied to it, as that is the behavior its callers will observe.

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

##### 3.8.3.1 Overridden Methods

A method that overrides a method from a base class does not need a docstring if it is explicitly decorated with `@override`, unless the overriding method’s behavior materially refines the base method’s contract, or details need to be provided (e.g., documenting additional side effects), in which case a docstring with at least those differences is required on the overriding method.

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

```
# 子类覆盖了方法却没有写 override，读者无法从装饰器跳回父类文档，这时必须自己写文档字符串。
class Child(Parent):
    def do_something(self):
        pass

# 只写“见父类”并没有补充契约，标了 override 就够指向父类，这种空文档应当去掉。
class Child(Parent):
    @override
    def do_something(self):
        """反例只让读者去看父类，没有写出这个覆盖方法自己改变了什么，标了 override 时不必留这句。
        """

```

#### 3.8.4 Classes

Classes should have a docstring below the class definition describing the class. Public attributes, excluding properties, should be documented here in an `Attributes` section and follow the same formatting as a function’s `Args` section.

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

All class docstrings should start with a one-line summary that describes what the class instance represents. This implies that subclasses of `Exception` should also describe what the exception represents, and not the context in which it might occur. The class docstring should not repeat unnecessary information, such as that the class is a class.

```
# 正例把对象含义或具体类型参数写出来，读者不用从类名或 Any 里猜测调用方得到什么。
class CheeseShopAddress:
    """这是一家奶酪店的地址，调用方用它定位店铺，而不是用它描述地址这个类本身，本例就是这样。
    """

class OutOfCheeseError(Exception):
    """表示奶酪已经没有库存。异常对象携带的是这种耗尽状态，而不是抛出它的那一层调用，本例就是这样。
    """

```

```
# 反例没有把对象含义或类型参数写清楚，读者只能看到名字，或者看到退回 Any 的签名。
class CheeseShopAddress:
    """反例用“这个类描述了什么”开头，摘要应直接说实例代表奶酪店地址，不要重复类这个词。
    """

class OutOfCheeseError(Exception):
    """反例强调异常会在什么时候被抛出。摘要应说明它代表奶酪耗尽，而不是抛出时的场景，本例就是这样。
    """

```

If a class is decorated, its docstrings must specify the behavior of the class after the decorator has been applied.

#### 3.8.5 Block and Inline Comments

The final place to have comments is in tricky parts of the code. If you’re going to have to explain it at the next code review, you should comment it now. Complicated operations get a few lines of comments before the operations commence. Non-obvious ones get comments at the end of the line.

```
# 用加权字典估计 i 在数组中的位置：先按最大值和长度外推，再二分找到精确下标，本例就是这样。

if i & (i-1) == 0:  # 当 i 为 0 或 2 的幂时这个位运算为真，只看运算符看不出这是在判断 2 的幂。

```

To improve legibility, these comments should start at least 2 spaces away from the code with the comment character `#`, followed by at least one space before the text of the comment itself.

On the other hand, never describe the code. Assume the person reading the code knows Python (though not what you’re trying to do) better than you do.

```
# 反例只是把循环再说一遍：走到 b 里的 i 时检查下一项是不是 i+1，没有说明为什么要这样配对。

```

#### 3.8.6 Punctuation, Spelling, and Grammar

Pay attention to punctuation, spelling, and grammar; it is easier to read well-written comments than badly written ones.

Comments should be as readable as narrative text, with proper capitalization and punctuation. In many cases, complete sentences are more readable than sentence fragments. Shorter comments, such as comments at the end of a line of code, can sometimes be less formal, but you should be consistent with your style.

Although it can be frustrating to have a code reviewer point out that you are using a comma when you should be using a semicolon, it is very important that source code maintain a high level of clarity and readability. Proper punctuation, spelling, and grammar help with that goal.

### 3.10 Strings

Use an f-string, the `%` operator, or the `format` method for formatting strings, even when the parameters are all strings. Use your best judgment to decide between string formatting options. A single join with `+` is okay but do not format with `+`.

```
Yes: x = f'name: {name}; score: {n}'
     x = '%s, %s!' % (imperative, expletive)
     x = '{}, {}'.format(first, second)
     x = 'name: %s; score: %d' % (name, n)
     x = 'name: %(name)s; score: %(score)d' % {'name':name, 'score':n}
     x = 'name: {}; score: {}'.format(name, n)
     x = a + b

```

```
No: x = first + ', ' + second
    x = 'name: ' + name + '; score: ' + str(n)

```

Avoid using the `+` and `+=` operators to accumulate a string within a loop. In some conditions, accumulating a string with addition can lead to quadratic rather than linear running time. Although common accumulations of this sort may be optimized on CPython, that is an implementation detail. The conditions under which an optimization applies are not easy to predict and may change. Instead, add each substring to a list and `''.join` the list after the loop terminates, or write each substring to an `io.StringIO` buffer. These techniques consistently have amortized-linear run-time complexity.

```
Yes: items = ['<table>']
     for last_name, first_name in employee_list:
         items.append('<tr><td>%s, %s</td></tr>' % (last_name, first_name))
     items.append('</table>')
     employee_table = ''.join(items)

```

```
No: employee_table = '<table>'
    for last_name, first_name in employee_list:
        employee_table += '<tr><td>%s, %s</td></tr>' % (last_name, first_name)
    employee_table += '</table>'

```

Be consistent with your choice of string quote character within a file. Pick `'` or `"` and stick with it. It is okay to use the other quote character on a string to avoid the need to backslash-escape quote characters within the string.

```
Yes:
    Python('Why are you hiding your eyes?')
    Gollum("I'm scared of lint errors.")
    Narrator('"Good!" thought a happy Python reviewer.')

```

```
No:
    Python("Why are you hiding your eyes?")
    Gollum('The lint. It burns. It burns us.')
    Gollum("Always the great lint. Watching. Watching.")

```

Prefer `"""` for multi-line strings rather than `'''`. Projects may choose to use `'''` for all non-docstring multi-line strings if and only if they also use `'` for regular strings. Docstrings must use `"""` regardless.

Multi-line strings do not flow with the indentation of the rest of the program. If you need to avoid embedding extra space in the string, use either concatenated single-line strings or a multi-line string with `textwrap.dedent()` to remove the initial space on each line:

```
    No:
    long_string = """This is pretty ugly.
Don't do this.
"""

```

```
    Yes:
    long_string = """This is fine if your use case can accept
      extraneous leading spaces."""

```

```
    Yes:
    long_string = ("And this is fine if you cannot accept\n" +
                                  "extraneous leading spaces.")

```

```
    Yes:
    long_string = ("And this too is fine if you cannot accept\n"
                                  "extraneous leading spaces.")

```

```
    Yes:
    import textwrap

    long_string = textwrap.dedent("""\
      This is also fine, because textwrap.dedent()
      will collapse common leading spaces in each line.""")

```

Note that using a backslash here does not violate the prohibition against explicit line continuation; in this case, the backslash is escaping a newline in a string literal.

#### 3.10.1 Logging

For logging functions that expect a pattern-string (with %-placeholders) as their first argument: Always call them with a string literal (not an f-string!) as their first argument with pattern-parameters as subsequent arguments. Some logging implementations collect the unexpanded pattern-string as a queryable field. It also prevents spending time rendering a message that no logger is configured to output.

```
    Yes:
    import tensorflow as tf
    logger = tf.get_logger()
    logger.info('TensorFlow Version is: %s', tf.__version__)

```

```
    Yes:
    import os
    from absl import logging

    logging.info('Current $PAGER is: %s', os.getenv('PAGER', default=''))

    homedir = os.getenv('HOME')
    if homedir is None or not os.access(homedir, os.W_OK):
        logging.error('Cannot write to home directory, $HOME=%r', homedir)

```

```
    No:
    import os
    from absl import logging

    logging.info('Current $PAGER is:')
    logging.info(os.getenv('PAGER', default=''))

    homedir = os.getenv('HOME')
    if homedir is None or not os.access(homedir, os.W_OK):
        logging.error(f'Cannot write to home directory, $HOME={homedir!r}')

```

#### 3.10.2 Error Messages

Error messages (such as: message strings on exceptions like `ValueError`, or messages shown to the user) should follow three guidelines:

1. The message needs to precisely match the actual error condition.
2. Interpolated pieces need to always be clearly identifiable as such.
3. They should allow simple automated processing (e.g. grepping).

```
    Yes:
    if not 0 <= p <= 1:
        raise ValueError(f'Not a probability: {p=}')

    try:
        os.rmdir(workdir)
    except OSError as error:
        logging.warning('Could not remove directory (reason: %r): %r',
                                        error, workdir)

```

```
    No:
    if p < 0 or p > 1:  # 这个比较对 float('nan') 也是假，不能用它判断概率是否落在闭区间里。
        raise ValueError(f'Not a probability: {p=}')

    try:
        os.rmdir(workdir)
    except OSError:
        # 删除失败不一定是因为目录已经不存在，这条日志把原因说死了，排查的人会被带偏，本例就是这样。
        logging.warning('Directory already was deleted: %s', workdir)

    try:
        os.rmdir(workdir)
    except OSError:
        # 把路径插进句子中间后，workdir 若刚好叫 deleted，日志会读成“已删除的目录无法删除”，也不利于按固定短语检索。
        logging.warning('The %s directory could not be deleted.', workdir)

```

### 3.11 Files, Sockets, and similar Stateful Resources

Explicitly close files and sockets when done with them. This rule naturally extends to closeable resources that internally use sockets, such as database connections, and also other resources that need to be closed down in a similar fashion. To name only a few examples, this also includes mmap mappings, h5py File objects, and matplotlib.pyplot figure windows.

Leaving files, sockets or other such stateful objects open unnecessarily has many downsides:

- They may consume limited system resources, such as file descriptors. Code that deals with many such objects may exhaust those resources unnecessarily if they’re not returned to the system promptly after use.
- Holding files open may prevent other actions such as moving or deleting them, or unmounting a filesystem.
- Files and sockets that are shared throughout a program may inadvertently be read from or written to after logically being closed. If they are actually closed, attempts to read or write from them will raise exceptions, making the problem known sooner.

Furthermore, while files and sockets (and some similarly behaving resources) are automatically closed when the object is destructed, coupling the lifetime of the object to the state of the resource is poor practice:

- There are no guarantees as to when the runtime will actually invoke the `__del__` method. Different Python implementations use different memory management techniques, such as delayed garbage collection, which may increase the object’s lifetime arbitrarily and indefinitely.
- Unexpected references to the file, e.g. in globals or exception tracebacks, may keep it around longer than intended.

Relying on finalizers to do automatic cleanup that has observable side effects has been rediscovered over and over again to lead to major problems, across many decades and multiple languages (see e.g. this article for Java).

The preferred way to manage files and similar resources is using the `with` statement:

```
with open("hello.txt") as hello_file:
    for line in hello_file:
        print(line)

```

For file-like objects that do not support the `with` statement, use `contextlib.closing()`:

```
import contextlib

with contextlib.closing(urllib.urlopen("http://www.python.org/")) as front_page:
    for line in front_page:
        print(line)

```

In rare cases where context-based resource management is infeasible, code documentation must explain clearly how resource lifetime is managed.

### 3.12 TODO Comments

Use `TODO` comments for code that is temporary, a short-term solution, or good-enough but not perfect.

A `TODO` comment begins with the word `TODO` in all caps, and a parenthesized link to a resource that contains the context, ideally a bug reference. A bug reference is preferable because bugs are tracked and have follow-up comments. Follow this piece of context with a colon and an explanatory string.

The purpose is to have a consistent `TODO` format that can be searched to find out how to get more details.

```
# TODO(example.com/12345): 调查这条路径上的 cpufreq 调节是否真能降低功耗，结论出来前不要把实验代码留在热路径。

```

Old style, formerly recommended, but discouraged for use in new code:

```
# TODO: example.com/12345 - 反例把链接和说明拆开了，TODO 应把缺陷链接放在括号里再写要调查的 cpufreq 问题。

```

Avoid adding TODOs that refer to an individual or team as the context:

```
# TODO(username): 先补上缺陷编号，再用星号表示这里的重复次数，不要让后人猜这个 TODO 归谁跟踪。

```

If your `TODO` is of the form “At a future date do something” make sure that you either include a very specific date (“Fix by November 2009”) or a very specific event (“Remove this code when all clients can handle XML responses.”) that future code maintainers will comprehend. Issues are ideal for tracking this.

### 3.13 Imports formatting

Imports should be on separate lines; there are exceptions for `typing` and `collections.abc` imports.

E.g.:

```
Yes: from collections.abc import Mapping, Sequence
     import os
     import sys
     from typing import Any, NewType

```

```
No:  import os, sys

```

Imports are always put at the top of the file, just after any module comments and docstrings and before module globals and constants. Imports should be grouped from most generic to least generic:

1. Python future import statements. For example:

```
from __future__ import annotations

```

See above for more information about those.
2. Python standard library imports. For example:

```
import sys

```
3. third-party module or package imports. For example:

```
import tensorflow as tf

```
4. Code repository sub-package imports. For example:

```
from otherproject.ai import mind

```
5. Deprecated: application-specific imports that are part of the same top-level sub-package as this file. For example:

```
from myproject.backend.hgwells import time_machine

```

You may find older Google Python Style code doing this, but it is no longer required. New code is encouraged not to bother with this. Simply treat application-specific sub-package imports the same as other sub-package imports.

Within each grouping, imports should be sorted lexicographically, ignoring case, according to each module’s full package path (the `path` in `from path import ...`). Code may optionally place a blank line between import sections.

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

# 旧代码有时把同包导入留在函数里，新代码不要再这样分组，下面两行只展示那种过时写法。
#from myproject.backend.hgwells import time_machine
#from myproject.backend.state_machine import main_loop

```

### 3.14 Statements

Generally only one statement per line.

However, you may put the result of a test on the same line as the test only if the entire statement fits on one line. In particular, you can never do so with `try`/`except` since the `try` and `except` can’t both fit on the same line, and you can only do so with an `if` if there is no `else`.

```
Yes:

    if foo: bar(foo)

```

```
No:

    if foo: bar(foo)
    else:   baz(foo)

    try:               bar(foo)
    except ValueError: baz(foo)

    try:
            bar(foo)
    except ValueError: baz(foo)

```

### 3.15 Getters and Setters

Getter and setter functions (also called accessors and mutators) should be used when they provide a meaningful role or behavior for getting or setting a variable’s value.

In particular, they should be used when getting or setting the variable is complex or the cost is significant, either currently or in a reasonable future.

If, for example, a pair of getters/setters simply read and write an internal attribute, the internal attribute should be made public instead. By comparison, if setting a variable means some state is invalidated or rebuilt, it should be a setter function. The function invocation hints that a potentially non-trivial operation is occurring. Alternatively, properties may be an option when simple logic is needed, or refactoring to no longer need getters and setters.

Getters and setters should follow the Naming guidelines, such as `get_foo()` and `set_foo()`.

If the past behavior allowed access through a property, do not bind the new getter/setter functions to the property. Any code still attempting to access the variable by the old method should break visibly so they are made aware of the change in complexity.

### 3.16 Naming

`module_name`, `package_name`, `ClassName`, `method_name`, `ExceptionName`, `function_name`, `GLOBAL_CONSTANT_NAME`, `global_var_name`, `instance_var_name`, `function_parameter_name`, `local_var_name`, `query_proper_noun_for_thing`, `send_acronym_via_https`.

Names should be descriptive. This includes functions, classes, variables, attributes, files and any other type of named entities.

Avoid abbreviation. In particular, do not use abbreviations that are ambiguous or unfamiliar to readers outside your project, and do not abbreviate by deleting letters within a word.

Always use a `.py` filename extension. Never use dashes.

#### 3.16.1 Names to Avoid

- single character names, except for specifically allowed cases:

- counters or iterators (e.g. `i`, `j`, `k`, `v`, et al.)
- `e` as an exception identifier in `try/except` statements.
- `f` as a file handle in `with` statements
- private type variables with no constraints (e.g. `_T = TypeVar("_T")`, `_P = ParamSpec("_P")`)
- names that match established notation in a reference paper or algorithm (see Mathematical Notation)

Please be mindful not to abuse single-character naming. Generally speaking, descriptiveness should be proportional to the name’s scope of visibility. For example, `i` might be a fine name for 5-line code block but within multiple nested scopes, it is likely too vague.
- dashes (`-`) in any package/module name
- `__double_leading_and_trailing_underscore__` names (reserved by Python)
- offensive terms
- names that needlessly include the type of the variable (for example: `id_to_name_dict`)

#### 3.16.2 Naming Conventions

- In general, follow PEP 8 naming conventions.
- “Internal” means internal to a module, or protected or private within a class.
- Prepending a single underscore (`_`) has some support for protecting module variables and functions (linters will flag protected member access). Note that it is okay for unit tests to access protected constants from the modules under test.
- Prepending a double underscore (`__` aka “dunder”) to an instance variable or method effectively makes the variable or method private to its class (using name mangling); we discourage its use as it impacts readability and testability, and isn’t really private. Prefer a single underscore.
- Place related classes and top-level functions together in a module. Unlike Java, there is no need to limit yourself to one class per module.
- Use CapWords for class names, but lower_with_under.py for module names. Although there are some old modules named CapWords.py, this is now discouraged because it’s confusing when the module happens to be named after a class. (“wait – did I write `import StringIO` or `from StringIO import StringIO`?”)

- Note that PEP 8 says: “When using acronyms in CapWords, capitalize all the letters of the acronym. Thus HTTPServerError is better than HttpServerError.”
- New unit test files follow PEP 8 compliant lower_with_under method names, for example, `test_<method_under_test>_ `. For consistency(*) with legacy modules that follow CapWords function names, underscores may appear in method names starting with `test` to separate logical components of the name. One possible pattern is `test _ `.

##### 3.16.2.1 Exemptions

The following exemptions apply to the general naming conventions above:

- When Python code is tightly coupled with an external or non-Python codebase, such as foreign function interfaces (FFIs) to C++, consistency with the other codebase may warrant following a different convention (Consistency).

#### 3.16.3 File Naming

Python filenames must have a `.py` extension and must not contain dashes (`-`). This allows them to be imported and unittested. If you want an executable to be accessible without the extension, use a symbolic link or a simple bash wrapper containing `exec "$0.py" "$@"`.

#### 3.16.4 Guidelines derived from Guido’s Recommendations

| Type | Public | Internal |
| --- | --- | --- |
| Packages | `lower_with_under` | |
| Modules | `lower_with_under` | `_lower_with_under` |
| Classes | `CapWords` | `_CapWords` |
| Exceptions | `CapWords` | |
| Functions | `lower_with_under()` | `_lower_with_under()` |
| Global/Class Constants | `CAPS_WITH_UNDER` | `_CAPS_WITH_UNDER` |
| Global/Class Variables | `lower_with_under` | `_lower_with_under` |
| Instance Variables | `lower_with_under` | `_lower_with_under` (protected) |
| Method Names | `lower_with_under()` | `_lower_with_under()` (protected) |
| Function/Method Parameters | `lower_with_under` | |
| Local Variables | `lower_with_under` | |

#### 3.16.5 Mathematical Notation

For mathematically-heavy code, short variable names that would otherwise violate the style guide are preferred when they match established notation in a reference paper or algorithm.

When using names based on established notation:

1. Cite the source of all naming conventions, preferably with a hyperlink to academic resource itself, in a comment or docstring. If the source is not accessible, clearly document the naming conventions.
2. Prefer PEP 8-compliant `descriptive_names` for public APIs, which are much more likely to be encountered out of context.
3. Use a narrowly-scoped `pylint: disable=invalid-name` directive to silence warnings. For just a few variables, use the directive as an endline comment for each one; for more, apply the directive at the beginning of a block.

### 3.17 Main

In Python, `pydoc` as well as unit tests require modules to be importable. If a file is meant to be used as an executable, its main functionality should be in a `main()` function, and your code should always check `if __name__ == '__main__'` before executing your main program, so that it is not executed when the module is imported.

When using absl, use `app.run`:

```
from absl import app
...

def main(argv: Sequence[str]):
    # 这里只处理旗标之外的位置参数，旗标解析要留在框架里，不要在 main 里再扫一遍 argv。
    ...

if __name__ == '__main__':
    app.run(main)

```

Otherwise, use:

```
def main():
    ...

if __name__ == '__main__':
    main()

```

All code at the top level will be executed when the module is imported. Be careful not to call functions, create objects, or perform other operations that should not be executed when the file is being `pydoc` ed.

### 3.18 Function length

Prefer small and focused functions.

We recognize that long functions are sometimes appropriate, so no hard limit is placed on function length. If a function exceeds about 40 lines, think about whether it can be broken up without harming the structure of the program.

Even if your long function works perfectly now, someone modifying it in a few months may add new behavior. This could result in bugs that are hard to find. Keeping your functions short and simple makes it easier for other people to read and modify your code.

You could find long and complicated functions when working with some code. Do not be intimidated by modifying existing code: if working with such a function proves to be difficult, you find that errors are hard to debug, or you want to use a piece of it in several different contexts, consider breaking up the function into smaller and more manageable pieces.

### 3.19 Type Annotations

#### 3.19.1 General Rules

- Familiarize yourself with type hints.
- Annotating `self` or `cls` is generally not necessary. `Self` can be used if it is necessary for proper type information, e.g.

```
from typing import Self

class BaseClass:
    @classmethod
    def create(cls) -> Self:
        ...

    def difference(self, other: Self) -> float:
        ...

```
- Similarly, don’t feel compelled to annotate the return value of `__init__` (where `None` is the only valid option).
- If any other variable or a returned type should not be expressed, use `Any`.
- You are not required to annotate all the functions in a module.

- At least annotate your public APIs.
- Use judgment to get to a good balance between safety and clarity on the one hand, and flexibility on the other.
- Annotate code that is prone to type-related errors (previous bugs or complexity).
- Annotate code that is hard to understand.
- Annotate code as it becomes stable from a types perspective. In many cases, you can annotate all the functions in mature code without losing too much flexibility.

#### 3.19.2 Line Breaking

Try to follow the existing indentation rules.

After annotating, many function signatures will become “one parameter per line”. To ensure the return type is also given its own line, a comma can be placed after the last parameter.

```
def my_method(
        self,
        first_var: int,
        second_var: Foo,
        third_var: Bar | None,
) -> int:
    ...

```

Always prefer breaking between variables, and not, for example, between variable names and type annotations. However, if everything fits on the same line, go for it.

```
def my_method(self, first_var: int) -> int:
    ...

```

If the combination of the function name, the last parameter, and the return type is too long, indent by 4 in a new line. When using line breaks, prefer putting each parameter and the return type on their own lines and aligning the closing parenthesis with the `def`:

```
Yes:
def my_method(
        self,
        other_arg: MyLongType | None,
) -> tuple[MyLongType1, MyLongType1]:
    ...

```

Optionally, the return type may be put on the same line as the last parameter:

```
Okay:
def my_method(
        self,
        first_var: int,
        second_var: int) -> dict[OtherLongType, MyLongType]:
    ...

```

`pylint` allows you to move the closing parenthesis to a new line and align with the opening one, but this is less readable.

```
No:
def my_method(self,
                            other_arg: MyLongType | None,
                          ) -> dict[OtherLongType, MyLongType]:
    ...

```

As in the examples above, prefer not to break types. However, sometimes they are too long to be on a single line (try to keep sub-types unbroken).

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

If a single name and type is too long, consider using an alias for the type. The last resort is to break after the colon and indent by 4.

```
Yes:
def my_function(
        long_variable_name:
                long_module_name.LongTypeName,
) -> None:
    ...

```

```
No:
def my_function(
        long_variable_name: long_module_name.
                LongTypeName,
) -> None:
    ...

```

#### 3.19.3 Forward Declarations

If you need to use a class name (from the same module) that is not yet defined – for example, if you need the class name inside the declaration of that class, or if you use a class that is defined later in the code – either use `from __future__ import annotations` or use a string for the class name.

```
Yes:
from __future__ import annotations

class MyClass:
    def __init__(self, stack: Sequence[MyClass], item: OtherClass) -> None:

class OtherClass:
    ...

```

```
Yes:
class MyClass:
    def __init__(self, stack: Sequence['MyClass'], item: 'OtherClass') -> None:

class OtherClass:
    ...

```

#### 3.19.4 Default Values

As per PEP-008, use spaces around the `=` only for arguments that have both a type annotation and a default value.

```
Yes:
def func(a: int = 0) -> int:
    ...

```

```
No:
def func(a:int=0) -> int:
    ...

```

#### 3.19.5 NoneType

In the Python type system, `NoneType` is a “first class” type, and for typing purposes, `None` is an alias for `NoneType`. If an argument can be `None`, it has to be declared! You can use `|` union type expressions (recommended in new Python 3.10+ code), or the older `Optional` and `Union` syntaxes.

Use explicit `X | None` instead of implicit. Earlier versions of type checkers allowed `a: str = None` to be interpreted as `a: str | None = None`, but that is no longer the preferred behavior.

```
Yes:
def modern_or_union(a: str | int | None, b: str | None = None) -> str:
    ...
def union_optional(a: Union[str, int, None], b: Optional[str] = None) -> str:
    ...

```

```
No:
def nullable_union(a: Union[None, str]) -> str:
    ...
def implicit_optional(a: str = None) -> str:
    ...

```

#### 3.19.6 Type Aliases

You can declare aliases of complex types.

- The name of an alias should be CapWorded. If the alias is used only in this module, it should be _Private.
- The alias should be type-annotated as `typing.TypeAlias`, to distinguish it from a non-type global variable.
- Do not use type aliases as a substitute for the `from module import symbol` idiom, which is not allowed.

```
Yes:
from typing import TypeAlias

_LossAndGradient: TypeAlias = tuple[tf.Tensor, tf.Tensor]
ComplexTFMap: TypeAlias = Mapping[str, _LossAndGradient]

```

```
No:
import immutabledict

immutabledict = immutabledict.immutabledict

```

```
# 模块内部可以用短别名减少行宽，但公共函数的签名里不要出现这个别名，调用方看不到它的定义。
_ShortName: TypeAlias = other_module.SignificantlyInconvenientlyLongName

```

#### 3.19.7 Ignoring Types

You can disable type checking on a line with the special comment `# type: ignore`.

`pyrefly` has a disable option for specific errors (similar to lint):

```
# 这一行的属性访问是类型检查器的误报，只抑制 attribute-error，不要把整段函数的检查都关掉。
# pyrefly: ignore[attribute-error]

```

#### 3.19.8 Typing Variables

Annotated Assignments
: If an internal variable has a type that is hard or impossible to infer, specify its type with an annotated assignment - use a colon and type between the variable name and value (the same as is done with function arguments that have a default value): 

```
a: Foo = SomeUndecoratedFunction()

```
Type Comments
: Though you may see them remaining in the codebase (they were necessary before Python 3.6), do not add any more uses of a `# type: ` comment on the end of the line: 

```
# 这是旧式行尾类型注释，只保留给对照，新代码应把 Foo 写在变量注解里，不要再新增这种写法。
a = SomeUndecoratedFunction()  # type: Foo

```

#### 3.19.9 Tuples vs Lists

Typed lists can only contain objects of a single type. Typed tuples can either have a single repeated type or a set number of elements with different types. The latter is commonly used as the return type from a function.

```
a: list[int] = [1, 2, 3]
b: tuple[int, ...] = (1, 2, 3)
c: tuple[int, str, float] = (1, "2", 3.5)

```

#### 3.19.10 Type variables

The Python type system has generics. A type variable, such as `TypeVar` and `ParamSpec`, is a common way to use them.

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

A `TypeVar` can be constrained:

```
AddableType = TypeVar("AddableType", int, float, str)
def add(a: AddableType, b: AddableType) -> AddableType:
    return a + b

```

A common predefined type variable in the `typing` module is `AnyStr`. Use it for multiple annotations that can be `bytes` or `str` and must all be the same type.

```
from typing import AnyStr
def check_length(x: AnyStr) -> AnyStr:
    if len(x) <= 42:
        return x
    raise ValueError()

```

A type variable must have a descriptive name, unless it meets all of the following criteria:

- not externally visible
- not constrained

```
Yes:
    _T = TypeVar("_T")
    _P = ParamSpec("_P")
    AddableType = TypeVar("AddableType", int, float, str)
    AnyFunction = TypeVar("AnyFunction", bound=Callable)

```

```
No:
    T = TypeVar("T")
    P = ParamSpec("P")
    _T = TypeVar("_T", int, float, str)
    _F = TypeVar("_F", bound=Callable)

```

#### 3.19.11 String types

> Do not use `typing.Text` in new code. It’s only for Python 2/3 compatibility.

Use `str` for string/text data. For code that deals with binary data, use `bytes`.

```
def deals_with_text_data(x: str) -> str:
    ...
def deals_with_binary_data(x: bytes) -> bytes:
    ...

```

If all the string types of a function are always the same, for example if the return type is the same as the argument type in the code above, use AnyStr.

#### 3.19.12 Imports For Typing

For symbols (including types, functions, and constants) from the `typing` or `collections.abc` modules used to support static analysis and type checking, always import the symbol itself. This keeps common annotations more concise and matches typing practices used around the world. You are explicitly allowed to import multiple specific symbols on one line from the `typing` and `collections.abc` modules. For example:

```
from collections.abc import Mapping, Sequence
from typing import Any, Generic, cast, TYPE_CHECKING

```

Given that this way of importing adds items to the local namespace, names in `typing` or `collections.abc` should be treated similarly to keywords, and not be defined in your Python code, typed or not. If there is a collision between a type and an existing name in a module, import it using `import x as y`.

```
from typing import Any as AnyType

```

When annotating function signatures, prefer abstract container types like `collections.abc.Sequence` over concrete types like `list`. If you need to use a concrete type (for example, a `tuple` of typed elements), prefer built-in types like `tuple` over the parametric type aliases from the `typing` module (e.g., `typing.Tuple`).

```
from typing import List, Tuple

def transform_coordinates(original: List[Tuple[float, float]]) ->
        List[Tuple[float, float]]:
    ...

```

```
from collections.abc import Sequence

def transform_coordinates(original: Sequence[tuple[float, float]]) ->
        Sequence[tuple[float, float]]:
    ...

```

#### 3.19.13 Conditional Imports

Use conditional imports only in exceptional cases where the additional imports needed for type checking must be avoided at runtime. This pattern is discouraged; alternatives such as refactoring the code to allow top-level imports should be preferred.

Imports that are needed only for type annotations can be placed within an `if TYPE_CHECKING:` block.

- Conditionally imported types need to be referenced as strings, to be forward compatible with Python 3.6 where the annotation expressions are actually evaluated.
- Only entities that are used solely for typing should be defined here; this includes aliases. Otherwise it will be a runtime error, as the module will not be imported at runtime.
- The block should be right after all the normal imports.
- There should be no empty lines in the typing imports list.
- Sort this list as if it were a regular imports list.

```
import typing
if typing.TYPE_CHECKING:
    import sketch
def f(x: "sketch.Sketch"): ...

```

#### 3.19.14 Circular Dependencies

Circular dependencies that are caused by typing are code smells. Such code is a good candidate for refactoring. Although technically it is possible to keep circular dependencies, various build systems will not let you do so because each module has to depend on the other.

Replace modules that create circular dependency imports with `Any`. Set an alias with a meaningful name, and use the real type name from this module (any attribute of `Any` is `Any`). Alias definitions should be separated from the last import by one line.

```
from typing import Any

some_mod = Any  # some_mod.py 会导入本模块，这里用字符串注解避开两个模块在导入时互相等待。
...

def my_method(self, var: "some_mod.SomeType") -> None:
    ...

```

#### 3.19.15 Generics

When annotating, prefer to specify type parameters for generic types in a parameter list; otherwise, the generics’ parameters will be assumed to be `Any`.

```
# 正例把对象含义或具体类型参数写出来，读者不用从类名或 Any 里猜测调用方得到什么。
def get_names(employee_ids: Sequence[int]) -> Mapping[int, str]:
    ...

```

```
# 反例没有写出类型参数，检查器会把它看成接收 Sequence[Any] 并返回 Mapping[Any, Any]。
def get_names(employee_ids: Sequence) -> Mapping:
    ...

```

If the best type parameter for a generic is `Any`, make it explicit, but remember that in many cases `TypeVar` might be more appropriate:

```
# 反例没有把对象含义或类型参数写清楚，读者只能看到名字，或者看到退回 Any 的签名。
def get_names(employee_ids: Sequence[Any]) -> Mapping[Any, str]:
    """按给定的员工编号返回编号到姓名的映射，编号的具体类型由调用方传入的序列决定，本例就是这样。
    """

```

```
# 正例把对象含义或具体类型参数写出来，读者不用从类名或 Any 里猜测调用方得到什么。
_T = TypeVar('_T')
def get_names(employee_ids: Sequence[_T]) -> Mapping[_T, str]:
    """按给定的员工编号返回编号到姓名的映射，编号的具体类型由调用方传入的序列决定，本例就是这样。
    """

```

## 4 Parting Words

BE CONSISTENT.

If you’re editing code, take a few minutes to look at the code around you and determine its style. If they use `_idx` suffixes in index variable names, you should too. If their comments have little boxes of hash marks around them, make your comments have little boxes of hash marks around them too.

The point of having style guidelines is to have a common vocabulary of coding so people can concentrate on what you’re saying rather than on how you’re saying it. We present global style rules here so people know the vocabulary, but local style is also important. If code you add to a file looks drastically different from the existing code around it, it throws readers out of their rhythm when they go to read it.

However, there are limits to consistency. It applies more heavily locally and on choices unspecified by the global style. Consistency should not generally be used as a justification to do things in an old style without considering the benefits of the new style, or the tendency of the codebase to converge on newer styles over time.
