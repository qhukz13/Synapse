---
type: project
domain: machine-learning
difficulty: beginner
status: not-started
builds: [Linear Regression, Residual Analysis]
---

# Calibrate a sensor

Use the readings from [[Linear Regression]] to compare two candidate calibration lines. Explain which line you would investigate further and which new measurement would help distinguish them.

## Steps

1. Enter the three measured voltages and reference temperatures.
2. Compute predictions for slopes of 1 and 2 while keeping the intercept at 3.
3. Compare the mean squared errors and describe the residuals.

## Stretch goals

- Add a fourth measurement at a higher voltage. Record how the comparison changes.

## Resources

- [Mean squared error](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.mean_squared_error.html)
