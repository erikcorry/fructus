; queens.lsp - SPEC92's li stand-in: every solution to the N-queens problem
;
; SPEC's li ran XLISP on an N-queens program.  This one counts the
; solutions on every board from 1x1 to 7x7, keeps the first it finds on
; each, and prints both: 1 0 0 2 10 4 40 solutions.  8x8 runs too, but
; takes four times as long as all the rest together.  A board is the list
; of the rows of the queens placed so far, the latest first, so each try is
; a cons and the garbage collector has work.

(defun safe (row dist placed)
  (cond ((null placed) t)
        ((or (= (car placed) row)
             (= (car placed) (+ row dist))
             (= (car placed) (- row dist)))
         nil)
        (t (safe row (1+ dist) (cdr placed)))))

(defun place (n col placed)
  (cond ((= col n)
         (if (null first) (setq first (reverse placed)))
         1)
        (t (let ((count 0))
             (dotimes (row n count)
               (if (safe row 1 placed)
                   (setq count
                         (+ count (place n (1+ col) (cons row placed))))))))))

(defun queens (n)
  (setq first nil)
  (list n (place n 0 nil) first))

(dotimes (i 7)
  (print (queens (1+ i))))
