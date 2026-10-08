# examples/Makefile - build the examples and run them on the simulator.
#
# Any .c, .cc or .cpp file here is an example, named after its file:
#
#   make                  build them all, into build/examples/
#   make NAME             build one
#   make show-NAME        run it with the display in an X11 window
#   make frames-NAME      run it, writing each frame as a PNG in
#                         build/examples/NAME-frames/
#   make run-NAME         run it, without the display
#
# From the top of the tree, `make -C examples show-display'.  The compiler is
# tools/fcc, which picks C or C++ by the file's name; CFLAGS are its options
# and SCALE the window's.  The exit status of a run is main's.

ROOT   := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
FCC    := $(ROOT)/tools/fcc
RUN    := node $(ROOT)/tools/fcc-run.mjs
OUT    := $(ROOT)/build/examples
CFLAGS ?= -O2
SCALE  ?= 2

NAMES  := $(sort $(basename $(wildcard *.c *.cc *.cpp)))
HEADERS := $(wildcard $(ROOT)/crt/include/*.h $(ROOT)/crt/include/*/*.h)

all: $(NAMES)
$(NAMES): %: $(OUT)/%.bin

$(OUT)/%.bin: %.c $(HEADERS) | $(OUT)
	$(FCC) $(CFLAGS) $< -o $(OUT)/$*
$(OUT)/%.bin: %.cc $(HEADERS) | $(OUT)
	$(FCC) $(CFLAGS) $< -o $(OUT)/$*
$(OUT)/%.bin: %.cpp $(HEADERS) | $(OUT)
	$(FCC) $(CFLAGS) $< -o $(OUT)/$*

$(OUT):
	mkdir -p $@

show-%: $(OUT)/%.bin
	$(RUN) $< --x11 --scale $(SCALE)
frames-%: $(OUT)/%.bin
	rm -rf $(OUT)/$*-frames
	$(RUN) $< --frames $(OUT)/$*-frames
run-%: $(OUT)/%.bin
	$(RUN) $< --stats

clean:
	rm -rf $(OUT)

.PHONY: all clean $(NAMES)
.SECONDARY:
