# openhintvc README

This is a simple VS Code addin to allow Stars in Shadow instances to open up specific files in response to in-game mouse clicks.

## Features

See this [forum post](http://stars-in-shadow.com/forum/viewtopic.php?f=5&t=717&p=8430#p8430) for more info.

At a low level -- running SiS with the '-devcat' command line option will tell the game to hook into devCAT VS Code debugger extension as it runs, which should give you access to breakpoints and other IDE essentials.

Running with '-devcat' will also tell SiS to communicate with VS Code via this openhintvc extension any time an in-game action suggests that opening up a certain source file is appropriate.  

Thus, if you click on a error message that pops up in game, the offending file/line should automatically open in VS Code.  Similarly, if you ctrl+click on most of the text in game, you should often be taken right to the line in the Lua sources where that text string is defined.