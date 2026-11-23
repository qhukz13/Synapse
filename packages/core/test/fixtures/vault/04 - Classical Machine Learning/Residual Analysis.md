---
type: concept
domain: machine-learning
difficulty: beginner
status: unread
importance: high
prerequisites: [Linear Regression]
---

# Residual Analysis

A residual is the signed difference $e_i = y_i - \hat y_i$. A positive residual means the observed response exceeded the prediction.

## Inspect a pattern

List residuals against input voltage. A steady increase across that range suggests a slope mismatch. A curved pattern can indicate a relationship that a straight line cannot capture.

## Prerequisites

- [[Linear Regression]]

## Exercises

1. For residuals of 1, −1 and 1, calculate the mean squared error.
2. Give two lists of three residuals with the same mean squared error and different signs.

## Resources

**Primary**

- [Prediction error display](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.PredictionErrorDisplay.html)
