---
type: concept
domain: programming
difficulty: beginner
status: unread
importance: high
prerequisites: []
---

# Python

A function gives a calculation a name. Start with one that converts a sensor reading into a prediction.

```python
def predict(reading, slope, intercept):
    return slope * reading + intercept

assert predict(4, 2, 1) == 9
```

## Exercises

1. Predict the output for reading 0 before running the function.
2. Write one assertion that detects a missing intercept.

## Resources

**Primary**

- [Defining functions](https://docs.python.org/3/tutorial/controlflow.html#defining-functions)

## Related concepts

[[Linear Regression]] uses this calculation once for each row of a dataset.
