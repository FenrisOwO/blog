---
title: Fixture Markdown
description: An article with a shortcode, Mermaid, math, a code block and an image.
date: 2024-05-07
slug: fixture-markdown
toc: false
tags:
  - Markdown
  - fixture
categories:
  - Fixture
---

Every special construct lives here: a body edit must not move a single byte of them.

## A heading

The shortcode, Mermaid, math, code block and image all follow this paragraph.

{{< admonition tip >}}
A shortcode.
{{< /admonition >}}

```mermaid
graph TD;
  A-->B;
```

Block math:

$$
a^2 + b^2 = c^2
$$

Inline math: \(x = 1\).

A code block:

```js
const answer = 42;
```

A list:

- first
- second

An image:

![fixture photo](../fixture-bundle/fixture-photo.jpg)

<!--more-->

<div class="fixture-div">raw HTML</div>
