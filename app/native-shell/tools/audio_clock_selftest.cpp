#include "audio_presentation.h"
#include <cmath>
#include <cstdio>
#include <limits>

int main() {
  voxora::AudioPresentation clock;
  auto close = [](double a, double b) { return std::abs(a - b) < 0.001; };
  if (!close(clock.target(10000, 3000), 7000)) return 1;
  // Late, longer translation: video follows source progress at half speed.
  if (!clock.update(10000, 4500, 0.5, 300)) return 2;
  if (!close(clock.target(10200, 3000), 5600)) return 3;
  if (!close(clock.target(10301, 3000), 7301)) return 4;
  if (clock.update(10000, 8000, 1, 300)) return 5;
  if (clock.update(10000, 3000, std::numeric_limits<double>::quiet_NaN(), 300)) return 6;
  if (!clock.update(10000, 3000, 2, 300) || !close(clock.target(10100, 3000), 7200)) return 7;
  clock.reset();
  if (clock.active(10001)) return 8;
  std::puts("audio presentation clock: 8 checks passed");
  return 0;
}
