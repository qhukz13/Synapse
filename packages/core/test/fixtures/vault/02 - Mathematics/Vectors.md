---
type: concept
domain: mathematics
difficulty: beginner
status: unread
importance: high
prerequisites: []
---

# Vectors

A vector records several quantities in a fixed order. For a sensor, the feature vector could be $\mathbf{x}=(1, 4)$, with one constant feature and one measured voltage.

| Coordinate | Value | Meaning |
| --- | ---: | --- |
| 1 | 1 | Constant feature |
| 2 | 4 | Voltage |

## Intuition

The order matters. If you trained a model with the constant first, pass new measurements in the same order.

## Resources

**Primary**

- [NumPy arrays](https://numpy.org/doc/stable/user/absolute_beginners.html)

## Related concepts

Combine features and coefficients with [[Dot Products]].
