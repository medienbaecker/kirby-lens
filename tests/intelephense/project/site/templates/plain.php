<?php

final class Plain
{
	public function real(): string
	{
		return 'x';
	}
}

$p = new Plain();
$q = $p->definitelyNotThere();
