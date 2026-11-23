---
type: concept
domain: machine-learning
difficulty: beginner
status: learning
importance: high
prerequisites: [Dot Products]
---

# Linear Regression

A linear model estimates a response by combining an input measurement with a slope and an intercept. For a temperature probe, $x$ might be the measured voltage and $y$ a reference temperature.

## Model

$$
\hat{y}_i = b + w x_i
$$

The slope $w$ is the change in the predicted response for a one-unit increase in the input. The intercept $b$ is the prediction at zero input. Together they define a line.

> [!tip] Read the units
> If the response is in degrees and the input is in volts, the slope is measured in degrees per volt.

## Worked example

Suppose $b=3$ and $w=2$. Calculate each prediction before inspecting the final column.

| Voltage | Observed | Predicted |
| ---: | ---: | ---: |
| 1 | 6 | 5 |
| 2 | 6 | 7 |
| 4 | 12 | 11 |

A least-squares fit chooses the coefficients that minimize the sum of squared differences between observed and predicted values. [[Residual Analysis|Inspect those differences]] before trusting the model on new inputs.

## Prerequisites

- [[Dot Products]]

## Exercises

1. Calculate the three residuals in the table.
2. Increase the intercept by one. Which residuals change sign?
3. Use [[Python]] to calculate the sum of squared residuals for both intercepts.

## Projects

- [[Project - Calibrate a Sensor]]

## Resources

**Primary**

- [Ordinary least squares](https://scikit-learn.org/stable/modules/linear_model.html#ordinary-least-squares)

**Supplementary**

- [LinearRegression estimator](https://scikit-learn.org/stable/modules/generated/sklearn.linear_model.LinearRegression.html)
